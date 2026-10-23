package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const OrgsDefaultUserKey = "orgs_default_for_user_id_key"

type Org struct {
	ID               string
	Name             string
	DefaultForUserID *string
	CreatedBy        string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

const orgColumns = `id::text, name, default_for_user_id::text, created_by::text, created_at, updated_at`

func scanOrg(row pgx.Row) (Org, error) {
	var o Org
	err := row.Scan(&o.ID, &o.Name, &o.DefaultForUserID, &o.CreatedBy, &o.CreatedAt, &o.UpdatedAt)
	return o, mapErr(err)
}

func (q *Q) InsertOrg(ctx context.Context, o Org) (Org, error) {
	return scanOrg(q.db.QueryRow(ctx, `INSERT INTO backend.orgs (id, name, default_for_user_id, created_by) VALUES ($1, $2, $3, $4) RETURNING `+orgColumns,
		o.ID, o.Name, o.DefaultForUserID, o.CreatedBy))
}

func (q *Q) GetOrg(ctx context.Context, id string) (Org, error) {
	return scanOrg(q.db.QueryRow(ctx, `SELECT `+orgColumns+` FROM backend.orgs WHERE id = $1`, id))
}

func (q *Q) LockOrg(ctx context.Context, id string) (Org, error) {
	return scanOrg(q.db.QueryRow(ctx, `SELECT `+orgColumns+` FROM backend.orgs WHERE id = $1 FOR UPDATE`, id))
}

func (q *Q) GetDefaultOrg(ctx context.Context, userID string) (Org, error) {
	return scanOrg(q.db.QueryRow(ctx, `SELECT `+orgColumns+` FROM backend.orgs WHERE default_for_user_id = $1`, userID))
}

func (q *Q) ListOrgs(ctx context.Context, ids []string, limit, offset int) ([]Org, int, error) {
	var total int
	if err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.orgs WHERE id = ANY($1::uuid[])`, ids).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.db.Query(ctx, `SELECT `+orgColumns+` FROM backend.orgs WHERE id = ANY($1::uuid[]) ORDER BY name COLLATE "C", id LIMIT $2 OFFSET $3`, ids, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	orgs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Org, error) { return scanOrg(r) })
	return orgs, total, err
}

func (q *Q) RenameOrg(ctx context.Context, id, name string) (Org, error) {
	return scanOrg(q.db.QueryRow(ctx, `UPDATE backend.orgs SET name = $2, updated_at = now() WHERE id = $1 RETURNING `+orgColumns, id, name))
}

func (q *Q) DeleteOrg(ctx context.Context, id string) error {
	tag, err := q.db.Exec(ctx, `DELETE FROM backend.orgs WHERE id = $1`, id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (q *Q) CountZonesInOrg(ctx context.Context, orgID string) (int, error) {
	var n int
	err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.zones WHERE org_id = $1`, orgID).Scan(&n)
	return n, err
}
