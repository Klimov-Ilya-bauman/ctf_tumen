package store

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	backendv1 "slopdns/web/gen/slopdns/backend/v1"
	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/pkg/dnsdata"
	"slopdns/web/pkg/pg"
)

var (
	ErrPruned = errors.New("store: revision is no longer in change_log")
	ErrReset  = errors.New("store: change_log was reset, the last sent revision is gone or differs")
)

const fingerprint = `encode(sha256(convert_to(created_at::text || '|' || zone_id::text || '|', 'UTF8') || ops), 'hex')`

type Change struct {
	Revision    uint64
	Ops         []*syncv1.Op
	Problems    []error
	Fingerprint string
}

type Position struct {
	Head        uint64
	Exists      bool
	Fingerprint string
}

type Snapshot struct {
	Revision    uint64
	Zones       []*syncv1.Zone
	Problems    []error
	Fingerprint string
}

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

var readOnly = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}

func toU64(v int64) uint64 {
	if v < 0 {
		return 0
	}
	return uint64(v)
}

func toI64(v uint64) int64 {
	if v > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(v)
}

func toU32(v int64) uint32 {
	if v < 0 || v > math.MaxUint32 {
		return 0
	}
	return uint32(v)
}

func toU16(v int32) uint16 {
	if v < 0 || v > math.MaxUint16 {
		return 0
	}
	return uint16(v)
}

func (s *Store) Head(ctx context.Context) (uint64, error) {
	var head int64
	if err := s.pool.QueryRow(ctx, `SELECT coalesce(max(revision), 0) FROM backend.change_log`).Scan(&head); err != nil {
		return 0, err
	}
	return toU64(head), nil
}

func (s *Store) Locate(ctx context.Context, revision uint64) (Position, error) {
	var head int64
	var fp *string
	err := s.pool.QueryRow(ctx, `SELECT coalesce((SELECT max(revision) FROM backend.change_log), 0), (SELECT `+fingerprint+` FROM backend.change_log WHERE revision = $1)`, toI64(revision)).Scan(&head, &fp)
	if err != nil {
		return Position{}, err
	}
	pos := Position{Head: toU64(head), Exists: fp != nil}
	if fp != nil {
		pos.Fingerprint = *fp
	}
	return pos, nil
}

func rowFingerprint(ctx context.Context, tx pgx.Tx, revision uint64) (string, bool, error) {
	var fp string
	err := tx.QueryRow(ctx, `SELECT `+fingerprint+` FROM backend.change_log WHERE revision = $1`, toI64(revision)).Scan(&fp)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return fp, err == nil, err
}

func decodeOps(payload []byte) ([]*syncv1.Op, error) {
	var msg backendv1.ChangeLogOps
	if err := proto.Unmarshal(payload, &msg); err != nil {
		return nil, err
	}
	return msg.GetOps(), nil
}

func (s *Store) ChangesAfter(ctx context.Context, after uint64, anchor string, limit int) ([]Change, error) {
	var out []Change
	err := pg.InTx(ctx, s.pool, readOnly, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT revision, ops, `+fingerprint+` FROM backend.change_log WHERE revision > $1 ORDER BY revision LIMIT $2`, toI64(after), limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var rev int64
			var payload []byte
			var fp string
			if err := rows.Scan(&rev, &payload, &fp); err != nil {
				return err
			}
			ops, err := decodeOps(payload)
			if err != nil {
				return fmt.Errorf("store: decode change_log revision %d: %w", rev, err)
			}
			clean, problems := dnsdata.SanitizeOps(ops)
			out = append(out, Change{Revision: toU64(rev), Ops: clean, Problems: problems, Fingerprint: fp})
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if after == 0 {
			return nil
		}
		fp, exists, err := rowFingerprint(ctx, tx, after)
		if err != nil {
			return err
		}
		switch {
		case !exists && len(out) > 0:
			return ErrPruned
		case !exists:
			return fmt.Errorf("%w: revision %d is above the change_log head", ErrReset, after)
		case anchor != "" && fp != anchor:
			return fmt.Errorf("%w: revision %d has different content", ErrReset, after)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

type zoneRow struct {
	id   string
	zone dnsdata.Zone
	rrs  []dnsdata.RR
}

func (s *Store) Snapshot(ctx context.Context) (*Snapshot, error) {
	snap := &Snapshot{}
	err := pg.InTx(ctx, s.pool, readOnly, func(tx pgx.Tx) error {
		var head int64
		if err := tx.QueryRow(ctx, `SELECT coalesce(max(revision), 0) FROM backend.change_log`).Scan(&head); err != nil {
			return err
		}
		snap.Revision = toU64(head)
		if snap.Revision > 0 {
			fp, _, err := rowFingerprint(ctx, tx, snap.Revision)
			if err != nil {
				return err
			}
			snap.Fingerprint = fp
		}
		zones, err := readZones(ctx, tx)
		if err != nil {
			return err
		}
		if err := readRecords(ctx, tx, zones); err != nil {
			return err
		}
		snap.Zones, snap.Problems = dnsdata.SanitizeZones(buildZones(zones))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return snap, nil
}

func readZones(ctx context.Context, tx pgx.Tx) ([]*zoneRow, error) {
	rows, err := tx.Query(ctx, `SELECT id::text, name, soa_mname, soa_rname, soa_serial, soa_refresh, soa_retry, soa_expire, soa_minimum, default_ttl FROM backend.zones ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*zoneRow
	for rows.Next() {
		var z zoneRow
		var serial int64
		var refresh, retry, expire, minimum, ttl int32
		if err := rows.Scan(&z.id, &z.zone.Apex, &z.zone.SOA.MName, &z.zone.SOA.RName, &serial, &refresh, &retry, &expire, &minimum, &ttl); err != nil {
			return nil, err
		}
		z.zone.SOA.Serial = toU32(serial)
		z.zone.SOA.Refresh = toU32(int64(refresh))
		z.zone.SOA.Retry = toU32(int64(retry))
		z.zone.SOA.Expire = toU32(int64(expire))
		z.zone.SOA.Minimum = toU32(int64(minimum))
		z.zone.SOATTL = toU32(int64(ttl))
		out = append(out, &z)
	}
	return out, rows.Err()
}

func readRecords(ctx context.Context, tx pgx.Tx, zones []*zoneRow) error {
	byID := make(map[string]*zoneRow, len(zones))
	for _, z := range zones {
		byID[z.id] = z
	}
	rows, err := tx.Query(ctx, `SELECT zone_id::text, owner, type, ttl, rdata_wire FROM backend.records WHERE class = 1`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var zoneID string
		var rr dnsdata.RR
		var typ, ttl int32
		if err := rows.Scan(&zoneID, &rr.Owner, &typ, &ttl, &rr.Wire); err != nil {
			return err
		}
		rr.Type = toU16(typ)
		rr.TTL = toU32(int64(ttl))
		if z, ok := byID[zoneID]; ok {
			z.rrs = append(z.rrs, rr)
		}
	}
	return rows.Err()
}

func buildZones(rows []*zoneRow) []*syncv1.Zone {
	out := make([]*syncv1.Zone, 0, len(rows))
	for _, z := range rows {
		msg, err := dnsdata.ZoneMessage(z.zone, z.rrs)
		if err != nil {
			msg = &syncv1.Zone{Apex: z.zone.Apex, Rrsets: dnsdata.RRSets(z.rrs)}
		}
		out = append(out, msg)
	}
	return out
}
