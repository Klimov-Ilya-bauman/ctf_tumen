package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const TransfersPendingKey = "zone_transfers_single_pending_idx"

type Transfer struct {
	ID          string
	ZoneID      string
	ZoneName    string
	FromOrgID   string
	FromUserID  string
	ToUserID    string
	TargetOrgID *string
	Status      string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	DecidedAt   *time.Time
}

const transferColumns = `id::text, zone_id::text, zone_name, from_org_id::text, from_user_id::text, to_user_id::text, target_org_id::text, status, created_at, expires_at, decided_at`

func scanTransfer(row pgx.Row) (Transfer, error) {
	var t Transfer
	err := row.Scan(&t.ID, &t.ZoneID, &t.ZoneName, &t.FromOrgID, &t.FromUserID, &t.ToUserID, &t.TargetOrgID, &t.Status, &t.CreatedAt, &t.ExpiresAt, &t.DecidedAt)
	return t, mapErr(err)
}

func (q *Q) InsertTransfer(ctx context.Context, t Transfer) (Transfer, error) {
	return scanTransfer(q.db.QueryRow(ctx, `INSERT INTO backend.zone_transfers (id, zone_id, zone_name, from_org_id, from_user_id, to_user_id, status, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING `+transferColumns,
		t.ID, t.ZoneID, t.ZoneName, t.FromOrgID, t.FromUserID, t.ToUserID, t.CreatedAt, t.ExpiresAt))
}

func (q *Q) GetTransfer(ctx context.Context, id string) (Transfer, error) {
	return scanTransfer(q.db.QueryRow(ctx, `SELECT `+transferColumns+` FROM backend.zone_transfers WHERE id = $1`, id))
}

func (q *Q) LockTransfer(ctx context.Context, id string) (Transfer, error) {
	return scanTransfer(q.db.QueryRow(ctx, `SELECT `+transferColumns+` FROM backend.zone_transfers WHERE id = $1 FOR UPDATE`, id))
}

func (q *Q) DecideTransfer(ctx context.Context, id, status string, targetOrgID *string, at time.Time) (Transfer, error) {
	return scanTransfer(q.db.QueryRow(ctx, `UPDATE backend.zone_transfers SET status = $2, target_org_id = $3, decided_at = $4 WHERE id = $1 AND status = 'pending' RETURNING `+transferColumns,
		id, status, targetOrgID, at))
}

func (q *Q) CancelPendingTransfers(ctx context.Context, zoneID string, at time.Time) error {
	_, err := q.db.Exec(ctx, `UPDATE backend.zone_transfers SET status = 'cancelled', decided_at = $2 WHERE zone_id = $1 AND status = 'pending'`, zoneID, at)
	return err
}

func (q *Q) ExpireTransfers(ctx context.Context, now time.Time) (int64, error) {
	tag, err := q.db.Exec(ctx, `UPDATE backend.zone_transfers SET status = 'expired', decided_at = $1 WHERE status = 'pending' AND expires_at <= $1`, now)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

type TransferFilter struct {
	Incoming   bool
	Outgoing   bool
	UserID     string
	AdminOrgs  []string
	AdminZones []string
	Status     string
}

func (q *Q) ListTransfers(ctx context.Context, f TransferFilter, limit, offset int) ([]Transfer, int, error) {
	where := `(($1 AND to_user_id::text = $3) OR ($2 AND (from_user_id::text = $3 OR from_org_id = ANY($4::uuid[]) OR zone_id = ANY($5::uuid[])))) AND ($6 = '' OR status = $6)`
	args := []any{f.Incoming, f.Outgoing, f.UserID, f.AdminOrgs, f.AdminZones, f.Status}
	var total int
	if err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.zone_transfers WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.db.Query(ctx, `SELECT `+transferColumns+` FROM backend.zone_transfers WHERE `+where+` ORDER BY created_at DESC, id DESC LIMIT $7 OFFSET $8`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Transfer, error) { return scanTransfer(r) })
	return out, total, err
}
