package pg

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"io/fs"
	"log/slog"
	"sync"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

type Options struct {
	MaxConns       int32
	ConnectTimeout time.Duration
	RetryInterval  time.Duration
	Logger         *slog.Logger
}

func Open(ctx context.Context, dsn string, opts Options) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("pg: invalid connection string")
	}
	if opts.MaxConns > 0 {
		cfg.MaxConns = opts.MaxConns
	}
	if opts.ConnectTimeout <= 0 {
		opts.ConnectTimeout = 30 * time.Second
	}
	if opts.RetryInterval <= 0 {
		opts.RetryInterval = 500 * time.Millisecond
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pg: create pool: %w", err)
	}
	if err := waitReady(ctx, pool, opts); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func waitReady(ctx context.Context, pool *pgxpool.Pool, opts Options) error {
	deadline := time.Now().Add(opts.ConnectTimeout)
	for {
		pingCtx, cancel := context.WithTimeout(ctx, opts.RetryInterval*4)
		err := pool.Ping(pingCtx)
		cancel()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("pg: database not reachable within %s: %w", opts.ConnectTimeout, err)
		}
		if opts.Logger != nil {
			opts.Logger.WarnContext(ctx, "database not ready, retrying", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(opts.RetryInterval):
		}
	}
}

func Checker(pool *pgxpool.Pool) func(context.Context) error {
	return func(ctx context.Context) error {
		return pool.Ping(ctx)
	}
}

type MigrationResult struct {
	Applied []int64
	Version int64
}

func Migrate(ctx context.Context, pool *pgxpool.Pool, migrations fs.FS) (MigrationResult, error) {
	db := stdlib.OpenDBFromPool(pool)
	defer func() { _ = db.Close() }()
	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations, goose.WithSessionLocker(NewSchemaLocker(DefaultLockRetry, DefaultLockTimeout)))
	if err != nil {
		return MigrationResult{}, fmt.Errorf("pg: load migrations: %w", err)
	}
	results, err := provider.Up(ctx)
	if err != nil {
		return MigrationResult{}, fmt.Errorf("pg: apply migrations: %w", err)
	}
	var out MigrationResult
	for _, r := range results {
		if r.Source != nil {
			out.Applied = append(out.Applied, r.Source.Version)
		}
	}
	out.Version, err = provider.GetDBVersion(ctx)
	if err != nil {
		return out, fmt.Errorf("pg: read schema version: %w", err)
	}
	return out, nil
}

type TxStarter interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

func InTx(ctx context.Context, db TxStarter, opts pgx.TxOptions, fn func(pgx.Tx) error) (err error) {
	tx, err := db.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("pg: begin: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(context.WithoutCancel(ctx))
			panic(p)
		}
		if err != nil {
			if rbErr := tx.Rollback(context.WithoutCancel(ctx)); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
				err = errors.Join(err, fmt.Errorf("pg: rollback: %w", rbErr))
			}
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("pg: commit: %w", err)
	}
	return nil
}

func FilesFS(files map[string]string) fs.FS {
	m := make(fstest.MapFS, len(files))
	for name, body := range files {
		m[name] = &fstest.MapFile{Data: []byte(body), Mode: 0o444}
	}
	return m
}

const (
	DefaultLockRetry   = 250 * time.Millisecond
	DefaultLockTimeout = 5 * time.Minute
	lockNamespace      = "slopdns-goose:"
)

type SchemaLocker struct {
	retry   time.Duration
	timeout time.Duration
	mu      sync.Mutex
	held    map[*sql.Conn]int64
}

func NewSchemaLocker(retry, timeout time.Duration) *SchemaLocker {
	if retry <= 0 {
		retry = DefaultLockRetry
	}
	if timeout <= 0 {
		timeout = DefaultLockTimeout
	}
	return &SchemaLocker{retry: retry, timeout: timeout, held: map[*sql.Conn]int64{}}
}

func LockID(schema string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(lockNamespace + schema))
	var id int64
	for _, b := range h.Sum(nil) {
		id = id<<8 | int64(b)
	}
	return id
}

func schemaLockID(ctx context.Context, conn *sql.Conn) (int64, error) {
	var schema sql.NullString
	if err := conn.QueryRowContext(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		return 0, fmt.Errorf("pg: read current schema: %w", err)
	}
	return LockID(schema.String), nil
}

func (l *SchemaLocker) SessionLock(ctx context.Context, conn *sql.Conn) error {
	id, err := schemaLockID(ctx, conn)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(l.timeout)
	for {
		var ok bool
		if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", id).Scan(&ok); err != nil {
			return fmt.Errorf("pg: acquire migration lock: %w", err)
		}
		if ok {
			l.mu.Lock()
			l.held[conn] = id
			l.mu.Unlock()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("pg: migration lock not acquired within %s", l.timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(l.retry):
		}
	}
}

func (l *SchemaLocker) SessionUnlock(ctx context.Context, conn *sql.Conn) error {
	l.mu.Lock()
	id, held := l.held[conn]
	delete(l.held, conn)
	l.mu.Unlock()
	if !held {
		return errors.New("pg: migration lock was not held")
	}
	var ok bool
	if err := conn.QueryRowContext(ctx, "SELECT pg_advisory_unlock($1)", id).Scan(&ok); err != nil {
		return fmt.Errorf("pg: release migration lock: %w", err)
	}
	if !ok {
		return errors.New("pg: migration lock was not held")
	}
	return nil
}
