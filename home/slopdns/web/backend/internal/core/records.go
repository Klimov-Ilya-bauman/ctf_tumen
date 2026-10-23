package core

import (
	"context"
	"encoding/json"
	"errors"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/conv"
	"slopdns/web/backend/internal/dnsname"
	"slopdns/web/backend/internal/integrity"
	"slopdns/web/backend/internal/rrdata"
	"slopdns/web/backend/internal/store"
	"slopdns/web/pkg/dnsdata"
	"slopdns/web/pkg/httpx"
)

type RecordInput struct {
	Name *string         `json:"name"`
	Type *string         `json:"type"`
	TTL  *int64          `json:"ttl"`
	Data json.RawMessage `json:"data"`
}

type parsedRecord struct {
	owner  string
	rec    *rrdata.Record
	data   []byte
	ttl    int32
	hasTTL bool
}

func parseRecordInput(in RecordInput, apex string) (parsedRecord, error) {
	if in.Name == nil {
		return parsedRecord{}, invalid("name", "is required")
	}
	if len(*in.Name) > 254 {
		return parsedRecord{}, invalid("name", "is longer than 254 characters")
	}
	owner, err := dnsname.ParseOwner(*in.Name, apex)
	if err != nil {
		return parsedRecord{}, invalid("name", err.Error())
	}
	if in.Type == nil {
		return parsedRecord{}, invalid("type", "is required")
	}
	ttl, hasTTL, err := intRange(in.TTL, "ttl", 0, MaxTTL)
	if err != nil {
		return parsedRecord{}, err
	}
	rec, err := rrdata.Parse(*in.Type, in.Data)
	if err != nil {
		var fe *rrdata.FieldError
		var se *rrdata.SyntaxError
		switch {
		case errors.As(err, &fe):
			return parsedRecord{}, invalid(fe.Field, fe.Message)
		case errors.As(err, &se):
			return parsedRecord{}, httpx.BadRequest(se.Message)
		}
		return parsedRecord{}, err
	}
	data, err := rec.DataJSON()
	if err != nil {
		return parsedRecord{}, err
	}
	return parsedRecord{owner: owner, rec: rec, data: data, ttl: ttl, hasTTL: hasTTL}, nil
}

func toExisting(ps []store.Placement) []integrity.Existing {
	out := make([]integrity.Existing, 0, len(ps))
	for _, p := range ps {
		out = append(out, integrity.Existing{ID: p.ID, Owner: p.Owner, Type: conv.U16(int64(p.Type))})
	}
	return out
}

func violation(v *integrity.Violation) error {
	field := v.Field
	if field == "" {
		return httpx.Validation("", v.Message)
	}
	return invalid(field, v.Message)
}

func (s *Service) placementCheck(ctx context.Context, q *store.Q, z store.Zone, pr parsedRecord, exceptID string) error {
	dup, err := q.DuplicateRecord(ctx, z.ID, pr.owner, int32(pr.rec.Type), pr.rec.Wire, exceptID)
	if err != nil {
		return err
	}
	if dup {
		return conflict("an identical record already exists")
	}
	neighbors, err := q.Neighborhood(ctx, z.ID, pr.owner, dnsname.Ancestors(pr.owner, z.Name))
	if err != nil {
		return err
	}
	if v := integrity.CheckAdd(z.Name, pr.owner, pr.rec.Type, integrity.Without(toExisting(neighbors), exceptID)); v != nil {
		return violation(v)
	}
	return nil
}

func (s *Service) resolveTTL(ctx context.Context, q *store.Q, z store.Zone, pr parsedRecord, exceptID string, fallback int32) (int32, error) {
	if pr.hasTTL {
		return pr.ttl, nil
	}
	members, err := q.RRSet(ctx, z.ID, pr.owner, int32(pr.rec.Type))
	if err != nil {
		return 0, err
	}
	for _, m := range members {
		if m.ID != exceptID {
			return m.TTL, nil
		}
	}
	return fallback, nil
}

func (s *Service) finishChange(ctx context.Context, q *store.Q, z store.Zone, keys [][2]any) error {
	serial, err := q.BumpSerial(ctx, z.ID)
	if err != nil {
		return err
	}
	z.SOASerial = serial
	ops := make([]*syncv1.Op, 0, len(keys)+1)
	seen := map[[2]any]bool{}
	for _, k := range keys {
		if seen[k] {
			continue
		}
		seen[k] = true
		owner, typ := k[0].(string), k[1].(int32)
		members, err := q.RRSet(ctx, z.ID, owner, typ)
		if err != nil {
			return err
		}
		rrs := make([]dnsdata.RR, 0, len(members))
		for _, m := range members {
			rrs = append(rrs, toRR(m))
		}
		ops = append(ops, dnsdata.RRSetOp(z.Name, owner, conv.U16(int64(typ)), rrs))
	}
	op, err := soaOp(z)
	if err != nil {
		return err
	}
	ops = append(ops, op)
	_, err = q.AppendChange(ctx, z.ID, ops)
	return err
}

func recordErr(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return notFound("record")
	}
	if store.IsUnique(err, store.RecordsUniqueKey) {
		return conflict("an identical record already exists")
	}
	return dbError(err)
}

func (s *Service) ListRecords(ctx context.Context, p authz.Principal, zoneID, name, typ string, pr PageReq) (Page[RecordView], error) {
	z, _, _, err := s.requireZone(ctx, p, zoneID, authz.ActionRead)
	if err != nil {
		return Page[RecordView]{}, err
	}
	var f store.RecordFilter
	if name != "" {
		owner, err := dnsname.ParseOwner(name, z.Name)
		if err != nil {
			return Page[RecordView]{}, invalid("name", err.Error())
		}
		f.Owner = owner
	}
	if typ != "" {
		code, err := rrdata.ParseFilterType(typ)
		if err != nil {
			return Page[RecordView]{}, invalid("type", "unknown record type")
		}
		f.Type, f.HasType = int32(code), true
	}
	list, total, err := s.store.Q().ListRecords(ctx, z.ID, f, pr.Limit, pr.Offset)
	if err != nil {
		return Page[RecordView]{}, dbError(err)
	}
	items := make([]RecordView, 0, len(list))
	for _, r := range list {
		items = append(items, recordView(r))
	}
	return newPage(items, total, pr), nil
}

func (s *Service) CreateRecord(ctx context.Context, p authz.Principal, zoneID string, in RecordInput) (RecordView, error) {
	z0, _, bs, err := s.requireZone(ctx, p, zoneID, authz.ActionWrite)
	if err != nil {
		return RecordView{}, err
	}
	pr, err := parseRecordInput(in, z0.Name)
	if err != nil {
		return RecordView{}, err
	}
	var out store.Record
	err = s.store.InTx(ctx, func(q *store.Q) error {
		z, err := s.lockZoneFor(ctx, q, bs, zoneID, authz.ActionWrite)
		if err != nil {
			return err
		}
		if n, err := q.CountRecords(ctx, z.ID); err != nil {
			return err
		} else if n >= s.limits.MaxRecordsPerZone {
			return quotaExceeded("zone_id", "records per zone", s.limits.MaxRecordsPerZone)
		}
		if err := s.checkZoneBytes(ctx, q, z.ID, "", pr.owner, len(pr.rec.Wire)); err != nil {
			return err
		}
		if err := s.placementCheck(ctx, q, z, pr, ""); err != nil {
			return err
		}
		ttl, err := s.resolveTTL(ctx, q, z, pr, "", z.DefaultTTL)
		if err != nil {
			return err
		}
		out, err = q.InsertRecord(ctx, store.Record{ID: newID(), ZoneID: z.ID, Owner: pr.owner, Type: int32(pr.rec.Type), TTL: ttl, Data: pr.data, Wire: pr.rec.Wire})
		if err != nil {
			return err
		}
		if err := q.SetRRSetTTL(ctx, z.ID, pr.owner, int32(pr.rec.Type), ttl); err != nil {
			return err
		}
		return s.finishChange(ctx, q, z, [][2]any{{pr.owner, int32(pr.rec.Type)}})
	})
	if err != nil {
		return RecordView{}, recordErr(err)
	}
	return recordView(out), nil
}

func (s *Service) loadRecord(ctx context.Context, p authz.Principal, id string, action authz.Action) (store.Record, store.Zone, []authz.Binding, error) {
	r, err := s.store.Q().GetRecord(ctx, id)
	if err != nil {
		return store.Record{}, store.Zone{}, nil, recordErr(err)
	}
	z, _, bs, err := s.requireZone(ctx, p, r.ZoneID, action)
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) && he.Status == 404 {
			return store.Record{}, store.Zone{}, nil, notFound("record")
		}
		return store.Record{}, store.Zone{}, nil, err
	}
	return r, z, bs, nil
}

func (s *Service) GetRecord(ctx context.Context, p authz.Principal, id string) (RecordView, error) {
	r, _, _, err := s.loadRecord(ctx, p, id, authz.ActionRead)
	if err != nil {
		return RecordView{}, err
	}
	return recordView(r), nil
}

func (s *Service) lockRecord(ctx context.Context, q *store.Q, bs []authz.Binding, r0 store.Record, action authz.Action) (store.Zone, store.Record, error) {
	z, err := s.lockZoneFor(ctx, q, bs, r0.ZoneID, action)
	if err != nil {
		return store.Zone{}, store.Record{}, err
	}
	r, err := q.GetRecord(ctx, r0.ID)
	if err != nil {
		return store.Zone{}, store.Record{}, err
	}
	if r.ZoneID != z.ID {
		return store.Zone{}, store.Record{}, store.ErrNotFound
	}
	return z, r, nil
}

func (s *Service) removalCheck(ctx context.Context, q *store.Q, z store.Zone, old store.Record) error {
	if conv.U16(int64(old.Type)) != rrdata.TypeNS || old.Owner != z.Name {
		return nil
	}
	n, err := q.ApexNSCount(ctx, z.ID, z.Name)
	if err != nil {
		return err
	}
	remaining := make([]integrity.Existing, 0, n)
	for i := 0; i < n-1; i++ {
		remaining = append(remaining, integrity.Existing{Owner: z.Name, Type: rrdata.TypeNS})
	}
	if v := integrity.CheckRemove(z.Name, integrity.Existing{ID: old.ID, Owner: old.Owner, Type: conv.U16(int64(old.Type))}, remaining); v != nil {
		return violation(v)
	}
	return nil
}

func (s *Service) ReplaceRecord(ctx context.Context, p authz.Principal, id string, in RecordInput) (RecordView, error) {
	r0, z0, bs, err := s.loadRecord(ctx, p, id, authz.ActionWrite)
	if err != nil {
		return RecordView{}, err
	}
	pr, err := parseRecordInput(in, z0.Name)
	if err != nil {
		return RecordView{}, err
	}
	var out store.Record
	err = s.store.InTx(ctx, func(q *store.Q) error {
		z, old, err := s.lockRecord(ctx, q, bs, r0, authz.ActionWrite)
		if err != nil {
			return err
		}
		if z.Name != z0.Name {
			if pr, err = parseRecordInput(in, z.Name); err != nil {
				return err
			}
		}
		moved := old.Owner != pr.owner || old.Type != int32(pr.rec.Type)
		if moved {
			if err := s.removalCheck(ctx, q, z, old); err != nil {
				return err
			}
		}
		if err := s.checkZoneBytes(ctx, q, z.ID, old.ID, pr.owner, len(pr.rec.Wire)); err != nil {
			return err
		}
		if err := s.placementCheck(ctx, q, z, pr, old.ID); err != nil {
			return err
		}
		fallback := z.DefaultTTL
		if !moved {
			fallback = old.TTL
		}
		ttl, err := s.resolveTTL(ctx, q, z, pr, old.ID, fallback)
		if err != nil {
			return err
		}
		out, err = q.UpdateRecord(ctx, store.Record{ID: old.ID, Owner: pr.owner, Type: int32(pr.rec.Type), TTL: ttl, Data: pr.data, Wire: pr.rec.Wire})
		if err != nil {
			return err
		}
		if err := q.SetRRSetTTL(ctx, z.ID, pr.owner, int32(pr.rec.Type), ttl); err != nil {
			return err
		}
		if out, err = q.GetRecord(ctx, old.ID); err != nil {
			return err
		}
		return s.finishChange(ctx, q, z, [][2]any{{pr.owner, int32(pr.rec.Type)}, {old.Owner, old.Type}})
	})
	if err != nil {
		return RecordView{}, recordErr(err)
	}
	return recordView(out), nil
}

func (s *Service) DeleteRecord(ctx context.Context, p authz.Principal, id string) error {
	r0, _, bs, err := s.loadRecord(ctx, p, id, authz.ActionWrite)
	if err != nil {
		return err
	}
	err = s.store.InTx(ctx, func(q *store.Q) error {
		z, old, err := s.lockRecord(ctx, q, bs, r0, authz.ActionWrite)
		if err != nil {
			return err
		}
		if err := s.removalCheck(ctx, q, z, old); err != nil {
			return err
		}
		if err := q.DeleteRecord(ctx, old.ID); err != nil {
			return err
		}
		return s.finishChange(ctx, q, z, [][2]any{{old.Owner, old.Type}})
	})
	if err != nil {
		return recordErr(err)
	}
	return nil
}
