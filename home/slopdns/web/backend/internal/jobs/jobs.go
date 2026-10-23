package jobs

import (
	"context"
	"hash/fnv"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Job struct {
	Name     string
	Interval time.Duration
	Run      func(ctx context.Context) error
}

type Runner struct {
	pool   *pgxpool.Pool
	logger *slog.Logger
	jobs   []Job
	mu     sync.Mutex
	conn   *pgxpool.Conn
}

func NewRunner(pool *pgxpool.Pool, logger *slog.Logger, jobs ...Job) *Runner {
	return &Runner{pool: pool, logger: logger, jobs: jobs}
}

func LockKey(name string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte("slopdns-backend-job:" + name))
	return int64(h.Sum64() >> 1)
}

func (r *Runner) dropConn(ctx context.Context) {
	if r.conn == nil {
		return
	}
	_ = r.conn.Conn().Close(context.WithoutCancel(ctx))
	r.conn.Release()
	r.conn = nil
}

func (r *Runner) tryLock(ctx context.Context, key int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn == nil {
		conn, err := r.pool.Acquire(ctx)
		if err != nil {
			return false, err
		}
		r.conn = conn
	}
	var locked bool
	if err := r.conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&locked); err != nil {
		r.dropConn(ctx)
		return false, err
	}
	return locked, nil
}

func (r *Runner) unlock(ctx context.Context, key int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conn == nil {
		return
	}
	if _, err := r.conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, key); err != nil {
		r.logger.WarnContext(ctx, "job unlock failed", slog.Any("error", err))
		r.dropConn(ctx)
	}
}

func (r *Runner) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dropConn(context.Background())
}

func (r *Runner) RunOnce(ctx context.Context, job Job) (bool, error) {
	key := LockKey(job.Name)
	locked, err := r.tryLock(ctx, key)
	if err != nil || !locked {
		return false, err
	}
	defer r.unlock(ctx, key)
	return true, job.Run(ctx)
}

func (r *Runner) Start(ctx context.Context) *sync.WaitGroup {
	var wg sync.WaitGroup
	for _, job := range r.jobs {
		wg.Add(1)
		go func(job Job) {
			defer wg.Done()
			ticker := time.NewTicker(job.Interval)
			defer ticker.Stop()
			for {
				if _, err := r.RunOnce(ctx, job); err != nil && ctx.Err() == nil {
					r.logger.ErrorContext(ctx, "job failed", slog.String("job", job.Name), slog.Any("error", err))
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}(job)
	}
	go func() {
		wg.Wait()
		r.Close()
	}()
	return &wg
}
