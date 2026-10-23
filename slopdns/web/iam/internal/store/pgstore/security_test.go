package pgstore

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/migrations"
	"slopdns/web/pkg/rbac"
)

// These integration tests create only a randomly named schema, never modify an
// existing iam schema, and remove their schema at cleanup. The database role
// needs CREATE SCHEMA permission. Run with SLOPDNS_TEST_DATABASE_URL set.
type schemaTx struct {
	pgx.Tx
	schema string
}

func (t schemaTx) sql(s string) string { return strings.ReplaceAll(s, "iam.", t.schema+".") }
func (t schemaTx) Exec(c context.Context, s string, a ...any) (pgconn.CommandTag, error) {
	return t.Tx.Exec(c, t.sql(s), a...)
}
func (t schemaTx) Query(c context.Context, s string, a ...any) (pgx.Rows, error) {
	return t.Tx.Query(c, t.sql(s), a...)
}
func (t schemaTx) QueryRow(c context.Context, s string, a ...any) pgx.Row {
	return t.Tx.QueryRow(c, t.sql(s), a...)
}

type securityDB struct {
	pool   *pgxpool.Pool
	schema string
}

func securityDatabase(t *testing.T) *securityDB {
	t.Helper()
	dsn := os.Getenv("SLOPDNS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set SLOPDNS_TEST_DATABASE_URL for PostgreSQL concurrency tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "security_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	db := &securityDB{p, schema}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := p.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
		p.Close()
	})
	if _, err := p.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_attempt_counters.sql", "0004_account_second_factor_budget.sql"} {
		raw, err := fs.ReadFile(migrations.FS(), name)
		if err != nil {
			t.Fatal(err)
		}
		up := strings.Split(string(raw), "-- +goose Down")[0]
		if _, err := p.Exec(ctx, strings.ReplaceAll(up, "iam.", schema+".")); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	return db
}

func (d *securityDB) begin(ctx context.Context) (*tx, error) {
	q, err := d.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &tx{q: schemaTx{q, d.schema}}, nil
}
func (d *securityDB) InTx(ctx context.Context, fn func(store.Tx) error) error {
	q, err := d.begin(ctx)
	if err != nil {
		return err
	}
	defer q.q.Rollback(ctx)
	if err := fn(q); err != nil {
		return err
	}
	return q.q.Commit(ctx)
}
func (d *securityDB) WithTryLock(context.Context, int64, func(store.Tx) error) (bool, error) {
	panic("unused")
}

func TestPostgresAccountBudgetConcurrentAndCooldown(t *testing.T) {
	d := securityDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id := uuid.New()
	now := time.Now().UTC()
	if err := d.InTx(ctx, func(q store.Tx) error {
		return q.CreateUser(ctx, store.User{ID: id, Username: "test-user", PasswordHash: "hash", CreatedAt: now, UpdatedAt: now})
	}); err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int32
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for range 40 {
		wg.Go(func() {
			err := d.InTx(ctx, func(q store.Tx) error {
				ok, err := q.ReserveSecondFactorAttempt(ctx, id, now)
				if ok {
					accepted.Add(1)
				}
				return err
			})
			if err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if got := accepted.Load(); got != store.MaxSecondFactorAttempts {
		t.Fatalf("concurrent account attempts: %d", got)
	}
	// Fresh challenges and session creation do not reset the budget.
	err := d.InTx(ctx, func(q store.Tx) error {
		for range 3 {
			if err := q.CreateMFAChallenge(ctx, store.MFAChallenge{ID: uuid.New(), UserID: id, SecretHash: make([]byte, 32), CreatedAt: now, ExpiresAt: now.Add(time.Minute)}); err != nil {
				return err
			}
		}
		ok, err := q.ReserveSecondFactorAttempt(ctx, id, now.Add(store.SecondFactorCooldown-time.Microsecond))
		if ok {
			return fmt.Errorf("fresh challenges reset budget")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.InTx(ctx, func(q store.Tx) error {
		ok, err := q.ReserveSecondFactorAttempt(ctx, id, now.Add(store.SecondFactorCooldown))
		if !ok {
			return fmt.Errorf("cooldown did not expire: %v", err)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresOwnerPromotionProtectsStaleMutations(t *testing.T) {
	for _, operation := range []string{"update", "delete"} {
		t.Run(operation, func(t *testing.T) {
			d := securityDatabase(t)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			org := uuid.New()
			b := store.RoleBinding{ID: uuid.New(), Principal: store.Principal{Type: rbac.PrincipalUser, ID: uuid.New()}, ResourceType: rbac.ResourceOrg, ResourceID: org, OrgID: org, Role: rbac.RoleAdmin, CreatedAt: time.Now()}
			if err := d.InTx(ctx, func(q store.Tx) error { return q.CreateBinding(ctx, b) }); err != nil {
				t.Fatal(err)
			}
			stale, err := d.begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer stale.q.Rollback(ctx)
			want, err := stale.BindingByID(ctx, b.ID)
			if err != nil {
				t.Fatal(err)
			}
			promoter, err := d.begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer promoter.q.Rollback(ctx)
			promoted := b
			promoted.Role = rbac.RoleOwner
			if err := promoter.UpdateBinding(ctx, promoted); err != nil {
				t.Fatal(err)
			}
			var pid int
			if err := stale.q.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if operation == "update" {
					want.Role = rbac.RoleReader
					err := stale.UpdateBinding(ctx, want)
					if err != store.ErrNotFound {
						result <- fmt.Errorf("stale update: %v", err)
						return
					}
				} else {
					deleted, err := stale.DeleteBindings(ctx, []uuid.UUID{want.ID})
					if err != nil || len(deleted) != 0 {
						result <- fmt.Errorf("stale delete removed %d: %v", len(deleted), err)
						return
					}
				}
				result <- stale.q.Commit(ctx)
			}()
			// Wait for the mutation to actually block on the promotion's row lock,
			// rather than relying on scheduling sleeps to establish the race.
			for {
				var waiting bool
				if err := d.pool.QueryRow(ctx, "SELECT COALESCE(wait_event_type = 'Lock', false) FROM pg_stat_activity WHERE pid=$1", pid).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case err := <-result:
					t.Fatalf("mutation did not wait for promotion: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if err := promoter.q.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-result; err != nil {
				t.Fatal(err)
			}
			if err := d.InTx(ctx, func(q store.Tx) error {
				got, err := q.BindingByID(ctx, b.ID)
				if err != nil {
					return err
				}
				if got.Role != rbac.RoleOwner {
					return fmt.Errorf("owner changed to %v", got.Role)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
