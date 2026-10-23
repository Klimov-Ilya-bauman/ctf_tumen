package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const ZonesNameKey = "zones_name_key"

type Zone struct {
	ID                string
	OrgID             string
	Name              string
	SOAMName          string
	SOARName          string
	SOASerial         int64
	SOARefresh        int32
	SOARetry          int32
	SOAExpire         int32
	SOAMinimum        int32
	DefaultTTL        int32
	CreatedAt         time.Time
	UpdatedAt         time.Time
	PendingTransferID *string
}

const zoneColumns = `z.id::text, z.org_id::text, z.name, z.soa_mname, z.soa_rname, z.soa_serial, z.soa_refresh, z.soa_retry, z.soa_expire, z.soa_minimum, z.default_ttl, z.created_at, z.updated_at,
	(SELECT t.id::text FROM backend.zone_transfers t WHERE t.zone_id = z.id AND t.status = 'pending' AND t.expires_at > now() LIMIT 1)`

func scanZone(row pgx.Row) (Zone, error) {
	var z Zone
	err := row.Scan(&z.ID, &z.OrgID, &z.Name, &z.SOAMName, &z.SOARName, &z.SOASerial, &z.SOARefresh, &z.SOARetry, &z.SOAExpire, &z.SOAMinimum, &z.DefaultTTL, &z.CreatedAt, &z.UpdatedAt, &z.PendingTransferID)
	return z, mapErr(err)
}

func (q *Q) InsertZone(ctx context.Context, z Zone) (Zone, error) {
	_, err := q.db.Exec(ctx, `INSERT INTO backend.zones (id, org_id, name, soa_mname, soa_rname, soa_serial, soa_refresh, soa_retry, soa_expire, soa_minimum, default_ttl)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		z.ID, z.OrgID, z.Name, z.SOAMName, z.SOARName, z.SOASerial, z.SOARefresh, z.SOARetry, z.SOAExpire, z.SOAMinimum, z.DefaultTTL)
	if err != nil {
		return Zone{}, mapErr(err)
	}
	return q.GetZone(ctx, z.ID)
}

func (q *Q) GetZone(ctx context.Context, id string) (Zone, error) {
	return scanZone(q.db.QueryRow(ctx, `SELECT `+zoneColumns+` FROM backend.zones z WHERE z.id = $1`, id))
}

func (q *Q) LockZoneByName(ctx context.Context, name string) (Zone, error) {
	return scanZone(q.db.QueryRow(ctx, `SELECT `+zoneColumns+` FROM backend.zones z WHERE z.name = $1 FOR UPDATE OF z`, name))
}

func (q *Q) LockZone(ctx context.Context, id string) (Zone, error) {
	return scanZone(q.db.QueryRow(ctx, `SELECT `+zoneColumns+` FROM backend.zones z WHERE z.id = $1 FOR UPDATE OF z`, id))
}

type ZoneFilter struct {
	OrgIDs  []string
	ZoneIDs []string
	OrgID   string
	NameSub string
}

func (q *Q) ListZones(ctx context.Context, f ZoneFilter, limit, offset int) ([]Zone, int, error) {
	where := `(z.org_id = ANY($1::uuid[]) OR z.id = ANY($2::uuid[])) AND ($3 = '' OR z.org_id::text = $3) AND ($4 = '' OR strpos(z.name, $4) > 0)`
	var total int
	if err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.zones z WHERE `+where, f.OrgIDs, f.ZoneIDs, f.OrgID, f.NameSub).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.db.Query(ctx, `SELECT `+zoneColumns+` FROM backend.zones z WHERE `+where+` ORDER BY z.name COLLATE "C", z.id LIMIT $5 OFFSET $6`,
		f.OrgIDs, f.ZoneIDs, f.OrgID, f.NameSub, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Zone, error) { return scanZone(r) })
	return out, total, err
}

type SOAUpdate struct {
	MName      string
	RName      string
	Refresh    int32
	Retry      int32
	Expire     int32
	Minimum    int32
	DefaultTTL int32
}

func (q *Q) UpdateZoneSettings(ctx context.Context, id string, u SOAUpdate) error {
	tag, err := q.db.Exec(ctx, `UPDATE backend.zones SET soa_mname = $2, soa_rname = $3, soa_refresh = $4, soa_retry = $5, soa_expire = $6, soa_minimum = $7, default_ttl = $8, updated_at = now() WHERE id = $1`,
		id, u.MName, u.RName, u.Refresh, u.Retry, u.Expire, u.Minimum, u.DefaultTTL)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (q *Q) BumpSerial(ctx context.Context, id string) (int64, error) {
	var serial int64
	err := q.db.QueryRow(ctx, `UPDATE backend.zones SET soa_serial = (soa_serial + 1) % 4294967296, updated_at = now() WHERE id = $1 RETURNING soa_serial`, id).Scan(&serial)
	return serial, mapErr(err)
}

func (q *Q) MoveZone(ctx context.Context, id, orgID string) error {
	tag, err := q.db.Exec(ctx, `UPDATE backend.zones SET org_id = $2, updated_at = now() WHERE id = $1`, id, orgID)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (q *Q) DeleteZone(ctx context.Context, id string) error {
	tag, err := q.db.Exec(ctx, `DELETE FROM backend.zones WHERE id = $1`, id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
