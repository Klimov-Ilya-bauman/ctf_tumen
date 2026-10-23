package store

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type OutboxEntry struct {
	ID        string
	Key       string
	Kind      string
	Payload   []byte
	Attempts  int
	CreatedAt time.Time
	DoneAt    *time.Time
	FailedAt  *time.Time
	LastError *string
	NextAt    time.Time
}

func (q *Q) EnqueueOutbox(ctx context.Context, kind, key string, payload []byte) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	_, err = q.db.Exec(ctx, `INSERT INTO backend.iam_outbox (id, kind, resource_key, payload) VALUES ($1, $2, $3, $4)`, id.String(), kind, key, payload)
	return id.String(), mapErr(err)
}

const outboxColumns = `id::text, resource_key, kind, payload, attempts, created_at, done_at, failed_at, last_error, next_attempt_at`

func scanOutbox(row pgx.Row) (OutboxEntry, error) {
	var e OutboxEntry
	err := row.Scan(&e.ID, &e.Key, &e.Kind, &e.Payload, &e.Attempts, &e.CreatedAt, &e.DoneAt, &e.FailedAt, &e.LastError, &e.NextAt)
	return e, mapErr(err)
}

func (q *Q) GetOutbox(ctx context.Context, id string) (OutboxEntry, error) {
	return scanOutbox(q.db.QueryRow(ctx, `SELECT `+outboxColumns+` FROM backend.iam_outbox WHERE id = $1`, id))
}

const noOlderPending = `NOT EXISTS (SELECT 1 FROM backend.iam_outbox o WHERE o.resource_key = c.resource_key AND o.id < c.id AND o.done_at IS NULL AND o.failed_at IS NULL)`

func (q *Q) ClaimOutbox(ctx context.Context, id string, now, leaseUntil time.Time) (OutboxEntry, error) {
	return scanOutbox(q.db.QueryRow(ctx, `UPDATE backend.iam_outbox c SET locked_until = $3, attempts = attempts + 1
		WHERE id = $1 AND done_at IS NULL AND failed_at IS NULL AND (locked_until IS NULL OR locked_until < $2) AND `+noOlderPending+`
		RETURNING `+outboxColumns, id, now, leaseUntil))
}

func (q *Q) ClaimHeadForKey(ctx context.Context, key, uptoID string, now, leaseUntil time.Time) (OutboxEntry, error) {
	return scanOutbox(q.db.QueryRow(ctx, `UPDATE backend.iam_outbox SET locked_until = $4, attempts = attempts + 1
		WHERE id = (SELECT id FROM backend.iam_outbox WHERE resource_key = $1 AND id <= $2 AND done_at IS NULL AND failed_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE)
		AND (locked_until IS NULL OR locked_until < $3)
		RETURNING `+outboxColumns, key, uptoID, now, leaseUntil))
}

func (q *Q) ClaimDueOutbox(ctx context.Context, now, leaseUntil time.Time, limit int) ([]OutboxEntry, error) {
	rows, err := q.db.Query(ctx, `UPDATE backend.iam_outbox SET locked_until = $2, attempts = attempts + 1
		WHERE id IN (SELECT c.id FROM backend.iam_outbox c WHERE c.done_at IS NULL AND c.failed_at IS NULL AND c.next_attempt_at <= $1 AND (c.locked_until IS NULL OR c.locked_until < $1)
			AND `+noOlderPending+` ORDER BY c.id LIMIT $3 FOR UPDATE SKIP LOCKED)
		RETURNING `+outboxColumns, now, leaseUntil, limit)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (OutboxEntry, error) { return scanOutbox(r) })
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (q *Q) CompleteOutbox(ctx context.Context, id string, at time.Time) error {
	_, err := q.db.Exec(ctx, `UPDATE backend.iam_outbox SET done_at = $2, locked_until = NULL, last_error = NULL WHERE id = $1 AND failed_at IS NULL`, id, at)
	return err
}

func (q *Q) RetryOutbox(ctx context.Context, id, lastError string, next time.Time) error {
	_, err := q.db.Exec(ctx, `UPDATE backend.iam_outbox SET locked_until = NULL, last_error = $2, next_attempt_at = $3 WHERE id = $1 AND done_at IS NULL`, id, lastError, next)
	return err
}

func (q *Q) FailOutbox(ctx context.Context, id, lastError string, at time.Time) error {
	_, err := q.db.Exec(ctx, `UPDATE backend.iam_outbox SET locked_until = NULL, last_error = $2, failed_at = $3 WHERE id = $1 AND done_at IS NULL`, id, lastError, at)
	return err
}

type OutboxStats struct {
	Pending int `json:"pending"`
	Stuck   int `json:"stuck"`
	Failed  int `json:"failed"`
}

func (q *Q) OutboxStats(ctx context.Context, stuckAttempts int) (OutboxStats, error) {
	var st OutboxStats
	err := q.db.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE done_at IS NULL AND failed_at IS NULL),
		count(*) FILTER (WHERE done_at IS NULL AND failed_at IS NULL AND attempts >= $1),
		count(*) FILTER (WHERE failed_at IS NOT NULL)
		FROM backend.iam_outbox`, stuckAttempts).Scan(&st.Pending, &st.Stuck, &st.Failed)
	return st, err
}

func (q *Q) PruneOutbox(ctx context.Context, before time.Time) (int64, error) {
	tag, err := q.db.Exec(ctx, `DELETE FROM backend.iam_outbox WHERE (done_at IS NOT NULL OR failed_at IS NOT NULL) AND created_at < $1`, before)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (q *Q) PruneChangeLog(ctx context.Context, before time.Time) (int64, error) {
	tag, err := q.db.Exec(ctx, `DELETE FROM backend.change_log WHERE created_at < $1 AND revision < (SELECT max(revision) FROM backend.change_log)`, before)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (q *Q) InsertTombstone(ctx context.Context, rtype, id, orgID string, at time.Time) error {
	_, err := q.db.Exec(ctx, `INSERT INTO backend.deleted_resources (resource_type, resource_id, org_id, deleted_at) VALUES ($1, $2, $3, $4)
		ON CONFLICT (resource_type, resource_id) DO UPDATE SET org_id = EXCLUDED.org_id, deleted_at = EXCLUDED.deleted_at`, rtype, id, orgID, at)
	return err
}

func (q *Q) PruneTombstones(ctx context.Context, before time.Time) (int64, error) {
	tag, err := q.db.Exec(ctx, `DELETE FROM backend.deleted_resources WHERE deleted_at < $1`, before)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (q *Q) ZoneOrgs(ctx context.Context, ids []string) (map[string]string, error) {
	rows, err := q.db.Query(ctx, `SELECT id::text, org_id::text FROM backend.zones WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, org string
		if err := rows.Scan(&id, &org); err != nil {
			return nil, err
		}
		out[id] = org
	}
	return out, rows.Err()
}

func (q *Q) OrgExists(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM backend.orgs WHERE id = $1)`, id).Scan(&ok)
	return ok, err
}

func (q *Q) ExistingOrgs(ctx context.Context, ids []string) (map[string]bool, error) {
	rows, err := q.db.Query(ctx, `SELECT id::text FROM backend.orgs WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(found))
	for _, id := range found {
		out[id] = true
	}
	return out, nil
}
