package core

import (
	"context"
	"errors"
	"strconv"
	"strings"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"
	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/conv"
	"slopdns/web/backend/internal/dnsname"
	"slopdns/web/backend/internal/outbox"
	"slopdns/web/backend/internal/rrdata"
	"slopdns/web/backend/internal/store"
	"slopdns/web/pkg/dnsdata"
)

type SOAInput struct {
	MName   *string `json:"mname"`
	RName   *string `json:"rname"`
	Refresh *int64  `json:"refresh"`
	Retry   *int64  `json:"retry"`
	Expire  *int64  `json:"expire"`
	Minimum *int64  `json:"minimum"`
}

type ZoneCreateInput struct {
	OrgID      *string   `json:"org_id"`
	Name       *string   `json:"name"`
	DefaultTTL *int64    `json:"default_ttl"`
	SOA        *SOAInput `json:"soa"`
}

type ZoneUpdateInput struct {
	DefaultTTL *int64    `json:"default_ttl"`
	SOA        *SOAInput `json:"soa"`
}

type soaValues struct {
	MName, RName                    string
	Refresh, Retry, Expire, Minimum int32
}

func intRange(p *int64, field string, lo, hi int64) (int32, bool, error) {
	if p == nil {
		return 0, false, nil
	}
	if *p < lo || *p > hi {
		return 0, false, invalid(field, "must be between "+strconv.FormatInt(lo, 10)+" and "+strconv.FormatInt(hi, 10))
	}
	return conv.I32(*p), true, nil
}

func hostInput(p *string, field string) (string, bool, error) {
	if p == nil {
		return "", false, nil
	}
	if len(*p) > 254 {
		return "", false, invalid(field, "is longer than 254 characters")
	}
	name, err := dnsname.ParseHost(*p, false)
	if err != nil {
		return "", false, invalid(field, err.Error())
	}
	return name, true, nil
}

func applySOA(base soaValues, in *SOAInput) (soaValues, error) {
	if in == nil {
		return base, nil
	}
	if in.MName == nil && in.RName == nil && in.Refresh == nil && in.Retry == nil && in.Expire == nil && in.Minimum == nil {
		return base, invalid("soa", "must contain at least one field")
	}
	out := base
	if v, ok, err := hostInput(in.MName, "soa.mname"); err != nil {
		return base, err
	} else if ok {
		out.MName = v
	}
	if v, ok, err := hostInput(in.RName, "soa.rname"); err != nil {
		return base, err
	} else if ok {
		out.RName = v
	}
	fields := []struct {
		p      *int64
		name   string
		lo, hi int64
		dst    *int32
	}{
		{in.Refresh, "soa.refresh", 60, MaxTTL, &out.Refresh},
		{in.Retry, "soa.retry", 60, MaxTTL, &out.Retry},
		{in.Expire, "soa.expire", 60, MaxTTL, &out.Expire},
		{in.Minimum, "soa.minimum", 0, 86400, &out.Minimum},
	}
	for _, f := range fields {
		v, ok, err := intRange(f.p, f.name, f.lo, f.hi)
		if err != nil {
			return base, err
		}
		if ok {
			*f.dst = v
		}
	}
	if out.Expire <= out.Refresh || out.Expire <= out.Retry {
		return base, invalid("soa.expire", "must be greater than refresh and retry (RFC 1912 section 2.2)")
	}
	return out, nil
}

func zoneData(z store.Zone) dnsdata.Zone {
	return dnsdata.Zone{
		Apex: z.Name,
		SOA: dnsdata.SOA{
			MName: z.SOAMName, RName: z.SOARName, Serial: conv.U32(z.SOASerial),
			Refresh: conv.U32(int64(z.SOARefresh)), Retry: conv.U32(int64(z.SOARetry)), Expire: conv.U32(int64(z.SOAExpire)), Minimum: conv.U32(int64(z.SOAMinimum)),
		},
		SOATTL: conv.U32(int64(z.DefaultTTL)),
	}
}

func toRR(r store.Record) dnsdata.RR {
	return dnsdata.RR{Owner: r.Owner, Type: conv.U16(int64(r.Type)), TTL: conv.U32(int64(r.TTL)), Wire: r.Wire}
}

func soaOp(z store.Zone) (*syncv1.Op, error) {
	set, err := dnsdata.SOARRSet(zoneData(z))
	if err != nil {
		return nil, err
	}
	return dnsdata.PutRRSet(z.Name, set), nil
}

func (s *Service) CreateZone(ctx context.Context, p authz.Principal, in ZoneCreateInput) (ZoneView, error) {
	if in.OrgID == nil {
		return ZoneView{}, invalid("org_id", "is required")
	}
	if !ValidUUID(*in.OrgID) {
		return ZoneView{}, invalid("org_id", "must be a UUID")
	}
	org, _, bs, err := s.requireOrg(ctx, p, *in.OrgID, authz.ActionWrite)
	if err != nil {
		return ZoneView{}, err
	}
	if in.Name == nil {
		return ZoneView{}, invalid("name", "is required")
	}
	if len(*in.Name) > 254 {
		return ZoneView{}, invalid("name", "is longer than 254 characters")
	}
	name, err := dnsname.ParseUserZone(*in.Name, s.defaults.Suffix)
	if err != nil {
		return ZoneView{}, invalid("name", err.Error())
	}
	if err := s.checkReserved(name); err != nil {
		return ZoneView{}, err
	}
	ttl := s.defaults.DefaultTTL
	if v, ok, err := intRange(in.DefaultTTL, "default_ttl", 0, MaxTTL); err != nil {
		return ZoneView{}, err
	} else if ok {
		ttl = v
	}
	soa, err := applySOA(soaValues{MName: s.defaults.MName, RName: s.defaults.RName, Refresh: s.defaults.Refresh, Retry: s.defaults.Retry, Expire: s.defaults.Expire, Minimum: s.defaults.Minimum}, in.SOA)
	if err != nil {
		return ZoneView{}, err
	}
	var zone store.Zone
	err = s.store.InTx(ctx, func(q *store.Q) error {
		if err := q.LockZoneTree(ctx); err != nil {
			return err
		}
		if err := s.checkNesting(ctx, q, name, org.ID, ""); err != nil {
			return err
		}
		if err := s.checkZoneQuota(ctx, q, org.ID, "org_id"); err != nil {
			return err
		}
		var err error
		zone, err = s.insertZone(ctx, q, store.Zone{
			ID: newID(), OrgID: org.ID, Name: name, SOAMName: soa.MName, SOARName: soa.RName, SOASerial: 1,
			SOARefresh: soa.Refresh, SOARetry: soa.Retry, SOAExpire: soa.Expire, SOAMinimum: soa.Minimum, DefaultTTL: ttl,
		}, nil)
		return err
	})
	if store.IsUnique(err, store.ZonesNameKey) {
		return ZoneView{}, conflict("zone name is already taken")
	}
	if errors.Is(err, store.ErrConflict) {
		return ZoneView{}, notFound("organization")
	}
	if err != nil {
		return ZoneView{}, dbError(err)
	}
	return zoneView(zone, authz.ZoneRole(bs, zone.ID, zone.OrgID)), nil
}

type extraRecord struct {
	owner string
	rec   *rrdata.Record
}

func (s *Service) insertZone(ctx context.Context, q *store.Q, z store.Zone, extra []extraRecord) (store.Zone, error) {
	zone, err := q.InsertZone(ctx, z)
	if err != nil {
		return store.Zone{}, err
	}
	for _, ns := range s.defaults.NameServers {
		rec, err := rrdata.Parse("NS", []byte(`{"nsdname":"`+ns+`"}`))
		if err != nil {
			return store.Zone{}, err
		}
		extra = append([]extraRecord{{owner: zone.Name, rec: rec}}, extra...)
	}
	var rrs []dnsdata.RR
	for _, x := range extra {
		data, err := x.rec.DataJSON()
		if err != nil {
			return store.Zone{}, err
		}
		r, err := q.InsertRecord(ctx, store.Record{ID: newID(), ZoneID: zone.ID, Owner: x.owner, Type: int32(x.rec.Type), TTL: zone.DefaultTTL, Data: data, Wire: x.rec.Wire})
		if err != nil {
			return store.Zone{}, err
		}
		rrs = append(rrs, toRR(r))
	}
	msg, err := dnsdata.ZoneMessage(zoneData(zone), rrs)
	if err != nil {
		return store.Zone{}, err
	}
	_, err = q.AppendChange(ctx, zone.ID, []*syncv1.Op{dnsdata.PutZone(msg)})
	return zone, err
}

func (s *Service) ListZones(ctx context.Context, p authz.Principal, orgID, nameSub string, pr PageReq) (Page[ZoneView], error) {
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return Page[ZoneView]{}, err
	}
	var orgIDs []string
	for _, b := range authz.OrgBindings(bs) {
		if b.Role >= authz.RoleReader {
			orgIDs = append(orgIDs, b.OrgID)
		}
	}
	zoneRoles, err := s.validZoneRoles(ctx, bs)
	if err != nil {
		return Page[ZoneView]{}, err
	}
	var zoneIDs []string
	for id := range zoneRoles {
		zoneIDs = append(zoneIDs, id)
	}
	zones, total, err := s.store.Q().ListZones(ctx, store.ZoneFilter{OrgIDs: orgIDs, ZoneIDs: zoneIDs, OrgID: orgID, NameSub: strings.ToLower(nameSub)}, pr.Limit, pr.Offset)
	if err != nil {
		return Page[ZoneView]{}, dbError(err)
	}
	items := make([]ZoneView, 0, len(zones))
	for _, z := range zones {
		items = append(items, zoneView(z, authz.ZoneRole(bs, z.ID, z.OrgID)))
	}
	return newPage(items, total, pr), nil
}

func (s *Service) GetZone(ctx context.Context, p authz.Principal, id string) (ZoneView, error) {
	z, role, _, err := s.requireZone(ctx, p, id, authz.ActionRead)
	if err != nil {
		return ZoneView{}, err
	}
	return zoneView(z, role), nil
}

func (s *Service) lockZoneFor(ctx context.Context, q *store.Q, bs []authz.Binding, id string, action authz.Action) (store.Zone, error) {
	z, err := q.LockZone(ctx, id)
	if err != nil {
		return store.Zone{}, err
	}
	if _, err := zoneAccess(bs, z, action); err != nil {
		return store.Zone{}, err
	}
	return z, nil
}

func (s *Service) UpdateZone(ctx context.Context, p authz.Principal, id string, in ZoneUpdateInput) (ZoneView, error) {
	_, role, bs, err := s.requireZone(ctx, p, id, authz.ActionWrite)
	if err != nil {
		return ZoneView{}, err
	}
	if in.DefaultTTL == nil && in.SOA == nil {
		return ZoneView{}, invalid("default_ttl", "at least one of default_ttl and soa is required")
	}
	ttl, hasTTL, err := intRange(in.DefaultTTL, "default_ttl", 0, MaxTTL)
	if err != nil {
		return ZoneView{}, err
	}
	var out store.Zone
	err = s.store.InTx(ctx, func(q *store.Q) error {
		z, err := s.lockZoneFor(ctx, q, bs, id, authz.ActionWrite)
		if err != nil {
			return err
		}
		soa, err := applySOA(soaValues{MName: z.SOAMName, RName: z.SOARName, Refresh: z.SOARefresh, Retry: z.SOARetry, Expire: z.SOAExpire, Minimum: z.SOAMinimum}, in.SOA)
		if err != nil {
			return err
		}
		if !hasTTL {
			ttl = z.DefaultTTL
		}
		if err := q.UpdateZoneSettings(ctx, z.ID, store.SOAUpdate{MName: soa.MName, RName: soa.RName, Refresh: soa.Refresh, Retry: soa.Retry, Expire: soa.Expire, Minimum: soa.Minimum, DefaultTTL: ttl}); err != nil {
			return err
		}
		if _, err := q.BumpSerial(ctx, z.ID); err != nil {
			return err
		}
		if out, err = q.GetZone(ctx, z.ID); err != nil {
			return err
		}
		op, err := soaOp(out)
		if err != nil {
			return err
		}
		_, err = q.AppendChange(ctx, z.ID, []*syncv1.Op{op})
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return ZoneView{}, notFound("zone")
	}
	if err != nil {
		return ZoneView{}, dbError(err)
	}
	return zoneView(out, max(role, authz.ZoneRole(bs, out.ID, out.OrgID))), nil
}

func (s *Service) DeleteZone(ctx context.Context, p authz.Principal, id string) error {
	_, _, bs, err := s.requireZone(ctx, p, id, authz.ActionManageAccess)
	if err != nil {
		return err
	}
	var ids []string
	err = s.store.InTx(ctx, func(q *store.Q) error {
		z, err := s.lockZoneFor(ctx, q, bs, id, authz.ActionManageAccess)
		if err != nil {
			return err
		}
		now := s.now()
		if err := q.CancelPendingTransfers(ctx, z.ID, now); err != nil {
			return err
		}
		if err := q.DeleteZone(ctx, z.ID); err != nil {
			return err
		}
		if err := q.InsertTombstone(ctx, "zone", z.ID, z.OrgID, now); err != nil {
			return err
		}
		kind, pl := outbox.RevokeResource(iamv1.ResourceType_RESOURCE_TYPE_ZONE, z.ID, z.OrgID)
		oid, err := outbox.Enqueue(ctx, q, kind, pl)
		if err != nil {
			return err
		}
		ids = append(ids, oid)
		_, err = q.AppendChange(ctx, z.ID, []*syncv1.Op{dnsdata.DeleteZone(z.Name)})
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return notFound("zone")
	}
	if err != nil {
		return dbError(err)
	}
	s.afterCommit(ctx, ids)
	return nil
}
