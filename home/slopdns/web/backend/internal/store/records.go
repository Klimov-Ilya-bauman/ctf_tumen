package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const RecordsUniqueKey = "records_unique_rr_idx"

type Record struct {
	ID        string
	ZoneID    string
	Owner     string
	Type      int32
	TTL       int32
	Data      []byte
	Wire      []byte
	CreatedAt time.Time
	UpdatedAt time.Time
}

const recordColumns = `id::text, zone_id::text, owner, type, ttl, data, rdata_wire, created_at, updated_at`

func scanRecord(row pgx.Row) (Record, error) {
	var r Record
	err := row.Scan(&r.ID, &r.ZoneID, &r.Owner, &r.Type, &r.TTL, &r.Data, &r.Wire, &r.CreatedAt, &r.UpdatedAt)
	return r, mapErr(err)
}

func collectRecords(rows pgx.Rows, err error) ([]Record, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Record, error) { return scanRecord(r) })
}

func (q *Q) InsertRecord(ctx context.Context, r Record) (Record, error) {
	return scanRecord(q.db.QueryRow(ctx, `INSERT INTO backend.records (id, zone_id, owner, type, ttl, data, rdata_wire) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING `+recordColumns,
		r.ID, r.ZoneID, r.Owner, r.Type, r.TTL, r.Data, r.Wire))
}

func (q *Q) UpdateRecord(ctx context.Context, r Record) (Record, error) {
	return scanRecord(q.db.QueryRow(ctx, `UPDATE backend.records SET owner = $2, type = $3, ttl = $4, data = $5, rdata_wire = $6, updated_at = now() WHERE id = $1 RETURNING `+recordColumns,
		r.ID, r.Owner, r.Type, r.TTL, r.Data, r.Wire))
}

func (q *Q) GetRecord(ctx context.Context, id string) (Record, error) {
	return scanRecord(q.db.QueryRow(ctx, `SELECT `+recordColumns+` FROM backend.records WHERE id = $1`, id))
}

func (q *Q) DeleteRecord(ctx context.Context, id string) error {
	tag, err := q.db.Exec(ctx, `DELETE FROM backend.records WHERE id = $1`, id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type RecordFilter struct {
	Owner   string
	Type    int32
	HasType bool
}

func (q *Q) ListRecords(ctx context.Context, zoneID string, f RecordFilter, limit, offset int) ([]Record, int, error) {
	where := `zone_id = $1 AND ($2 = '' OR owner = $2) AND (NOT $3 OR type = $4)`
	var total int
	if err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.records WHERE `+where, zoneID, f.Owner, f.HasType, f.Type).Scan(&total); err != nil {
		return nil, 0, err
	}
	out, err := collectRecords(q.db.Query(ctx, `SELECT `+recordColumns+` FROM backend.records WHERE `+where+` ORDER BY owner COLLATE "C", type, id LIMIT $5 OFFSET $6`,
		zoneID, f.Owner, f.HasType, f.Type, limit, offset))
	return out, total, err
}

func (q *Q) RRSet(ctx context.Context, zoneID, owner string, typ int32) ([]Record, error) {
	return collectRecords(q.db.Query(ctx, `SELECT `+recordColumns+` FROM backend.records WHERE zone_id = $1 AND owner = $2 AND type = $3 ORDER BY id`, zoneID, owner, typ))
}

func (q *Q) SetRRSetTTL(ctx context.Context, zoneID, owner string, typ, ttl int32) error {
	_, err := q.db.Exec(ctx, `UPDATE backend.records SET ttl = $4, updated_at = now() WHERE zone_id = $1 AND owner = $2 AND type = $3 AND ttl <> $4`, zoneID, owner, typ, ttl)
	return err
}

func (q *Q) DuplicateRecord(ctx context.Context, zoneID, owner string, typ int32, wire []byte, exceptID string) (bool, error) {
	var dup bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM backend.records WHERE zone_id = $1 AND owner = $2 AND type = $3 AND sha256(rdata_wire) = sha256($4::bytea) AND rdata_wire = $4 AND id::text <> $5)`,
		zoneID, owner, typ, wire, exceptID).Scan(&dup)
	return dup, err
}

type Placement struct {
	ID    string
	Owner string
	Type  int32
}

func (q *Q) Neighborhood(ctx context.Context, zoneID, owner string, ancestors []string) ([]Placement, error) {
	rows, err := q.db.Query(ctx, `SELECT id::text, owner, type FROM backend.records
		WHERE zone_id = $1 AND (owner = $2 OR right(owner, length($2) + 1) = '.' || $2 OR (type = 39 AND owner = ANY($3::text[])))`, zoneID, owner, ancestors)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Placement, error) {
		var p Placement
		err := r.Scan(&p.ID, &p.Owner, &p.Type)
		return p, err
	})
}

func (q *Q) ApexNSCount(ctx context.Context, zoneID, apex string) (int, error) {
	var n int
	err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.records WHERE zone_id = $1 AND owner = $2 AND type = 2`, zoneID, apex).Scan(&n)
	return n, err
}
