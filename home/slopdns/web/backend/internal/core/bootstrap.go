package core

import (
	"context"
	"errors"
	"fmt"
	"net/netip"

	"slopdns/web/backend/internal/dnsname"
	"slopdns/web/backend/internal/rrdata"
	"slopdns/web/backend/internal/store"
)

const (
	SystemOrgName   = "slopdns-system"
	SystemPrincipal = "00000000-0000-0000-0000-000000000000"
)

type BootstrapResult struct {
	OrgID       string
	ZoneID      string
	Zone        string
	OrgCreated  bool
	ZoneCreated bool
	Updated     []string
}

func (r BootstrapResult) Changed() bool {
	return r.OrgCreated || r.ZoneCreated || len(r.Updated) > 0
}

func ValidIPv4(s string) bool {
	a, err := netip.ParseAddr(s)
	return err == nil && a.Is4() && a.String() == s
}

func InfraZoneName(d ZoneDefaults, explicit string) (string, error) {
	if explicit != "" {
		return dnsname.Parse(explicit, dnsname.ZonePolicy)
	}
	if len(d.NameServers) == 0 {
		return "", errors.New("no nameservers configured")
	}
	parents := dnsname.Ancestors(d.NameServers[0], dnsname.Root)
	if len(parents) == 0 || parents[0] == dnsname.Root {
		return "", fmt.Errorf("nameserver %s has no parent zone", d.NameServers[0])
	}
	return parents[0], nil
}

func (s *Service) BootstrapInfra(ctx context.Context, zoneName, address string) (BootstrapResult, error) {
	var res BootstrapResult
	if !ValidIPv4(address) {
		return res, fmt.Errorf("infra NS address %q is not a dotted-quad IPv4 address", address)
	}
	a, err := rrdata.Parse("A", []byte(`{"address":"`+address+`"}`))
	if err != nil {
		return res, err
	}
	var hosts []string
	for _, ns := range s.defaults.NameServers {
		if dnsname.IsStrictSubdomain(ns, zoneName) {
			hosts = append(hosts, ns)
		}
	}
	err = s.store.InTx(ctx, func(q *store.Q) error {
		if err := q.LockZoneTree(ctx); err != nil {
			return err
		}
		org, err := q.GetDefaultOrg(ctx, SystemPrincipal)
		if errors.Is(err, store.ErrNotFound) {
			sys := SystemPrincipal
			org, err = q.InsertOrg(ctx, store.Org{ID: newID(), Name: SystemOrgName, DefaultForUserID: &sys, CreatedBy: SystemPrincipal})
			res.OrgCreated = true
		}
		if err != nil {
			return err
		}
		res.OrgID = org.ID
		zone, err := q.LockZoneByName(ctx, zoneName)
		if errors.Is(err, store.ErrNotFound) {
			extra := make([]extraRecord, 0, len(hosts))
			for _, h := range hosts {
				extra = append(extra, extraRecord{owner: h, rec: a})
			}
			zone, err = s.insertZone(ctx, q, store.Zone{
				ID: newID(), OrgID: org.ID, Name: zoneName, SOAMName: s.defaults.MName, SOARName: s.defaults.RName, SOASerial: 1,
				SOARefresh: s.defaults.Refresh, SOARetry: s.defaults.Retry, SOAExpire: s.defaults.Expire, SOAMinimum: s.defaults.Minimum, DefaultTTL: s.defaults.DefaultTTL,
			}, extra)
			if err != nil {
				return err
			}
			res.ZoneID, res.Zone, res.ZoneCreated = zone.ID, zone.Name, true
			return nil
		}
		if err != nil {
			return err
		}
		if zone.OrgID != org.ID {
			return fmt.Errorf("zone %s exists but belongs to organization %s, not to %s", zoneName, zone.OrgID, SystemOrgName)
		}
		res.ZoneID, res.Zone = zone.ID, zone.Name
		var keys [][2]any
		for _, h := range hosts {
			members, err := q.RRSet(ctx, zone.ID, h, int32(rrdata.TypeA))
			if err != nil {
				return err
			}
			if len(members) == 1 && string(members[0].Wire) == string(a.Wire) {
				continue
			}
			for _, m := range members {
				if err := q.DeleteRecord(ctx, m.ID); err != nil {
					return err
				}
			}
			data, err := a.DataJSON()
			if err != nil {
				return err
			}
			if _, err := q.InsertRecord(ctx, store.Record{ID: newID(), ZoneID: zone.ID, Owner: h, Type: int32(rrdata.TypeA), TTL: zone.DefaultTTL, Data: data, Wire: a.Wire}); err != nil {
				return err
			}
			keys = append(keys, [2]any{h, int32(rrdata.TypeA)})
			res.Updated = append(res.Updated, h)
		}
		if len(keys) == 0 {
			return nil
		}
		return s.finishChange(ctx, q, zone, keys)
	})
	return res, err
}
