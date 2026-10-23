package store

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"

	backendv1 "slopdns/web/gen/slopdns/backend/v1"
	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/pkg/pg"
)

const (
	NotifyChannel    = "slopdns_changes"
	ChangeLogLockKey = int64(0x736c6f70646e7331)
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

type UniqueError struct {
	Constraint string
}

func (e *UniqueError) Error() string {
	return "unique violation: " + e.Constraint
}

type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}

func (s *Store) Q() *Q {
	return &Q{db: s.pool}
}

func (s *Store) InTx(ctx context.Context, fn func(q *Q) error) error {
	return pg.InTx(ctx, s.pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
		return fn(&Q{db: tx, tx: true})
	})
}

type Q struct {
	db querier
	tx bool
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return &UniqueError{Constraint: pgErr.ConstraintName}
		case "23503":
			return ErrConflict
		}
	}
	return err
}

func IsUnique(err error, constraint string) bool {
	var ue *UniqueError
	return errors.As(err, &ue) && (constraint == "" || ue.Constraint == constraint)
}

func (q *Q) AppendChange(ctx context.Context, zoneID string, ops []*syncv1.Op) (int64, error) {
	if !q.tx {
		return 0, errors.New("store: AppendChange requires a transaction")
	}
	payload, err := proto.Marshal(&backendv1.ChangeLogOps{Ops: ops})
	if err != nil {
		return 0, err
	}
	if _, err := q.db.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, ChangeLogLockKey); err != nil {
		return 0, err
	}
	var rev int64
	if err := q.db.QueryRow(ctx, `INSERT INTO backend.change_log (zone_id, ops) VALUES ($1, $2) RETURNING revision`, zoneID, payload).Scan(&rev); err != nil {
		return 0, mapErr(err)
	}
	if _, err := q.db.Exec(ctx, `SELECT pg_notify($1, $2)`, NotifyChannel, strconv.FormatInt(rev, 10)); err != nil {
		return 0, err
	}
	return rev, nil
}

type ChangeEntry struct {
	Revision  int64
	ZoneID    string
	Ops       []*syncv1.Op
	CreatedAt time.Time
}

func (q *Q) ChangesAfter(ctx context.Context, after int64, limit int) ([]ChangeEntry, error) {
	rows, err := q.db.Query(ctx, `SELECT revision, zone_id, ops, created_at FROM backend.change_log WHERE revision > $1 ORDER BY revision LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChangeEntry
	for rows.Next() {
		var e ChangeEntry
		var payload []byte
		if err := rows.Scan(&e.Revision, &e.ZoneID, &payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		var msg backendv1.ChangeLogOps
		if err := proto.Unmarshal(payload, &msg); err != nil {
			return nil, err
		}
		e.Ops = msg.Ops
		out = append(out, e)
	}
	return out, rows.Err()
}
