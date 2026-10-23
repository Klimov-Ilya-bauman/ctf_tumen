package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Requires an explicitly supplied disposable LOCAL PostgreSQL database.
func securityStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" { t.Skip("TEST_DATABASE_URL is required for PostgreSQL security tests") }
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil { t.Fatal(err) }
	var suffix [12]byte
	if _, err := rand.Read(suffix[:]); err != nil { admin.Close(); t.Fatal(err) }
	schema := "security_test_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, "CREATE SCHEMA " + schema); err != nil { admin.Close(); t.Fatal(err) }
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA " + schema + " CASCADE"); err != nil { t.Error(err) }
		admin.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil { t.Fatal(err) }
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil { t.Fatal(err) }
	s := &Store{Pool:pool}
	t.Cleanup(s.Close)
	if err := s.Migrate(ctx); err != nil { t.Fatal(err) }
	if err := s.Migrate(ctx); err != nil { t.Fatalf("migration is not repeatable: %v", err) }
	return s
}

func TestSessionLifecycle(t *testing.T) {
	s := securityStore(t)
	ctx := context.Background()
	uid, err := s.CreateUser(ctx, "alice", "test-only")
	if err != nil { t.Fatal(err) }
	for _, tc := range []struct { hash string; expiry time.Time; valid bool }{
		{"active-test-digest", time.Now().Add(time.Hour), true},
		{"expired-test-digest", time.Now().Add(-time.Hour), false},
	} {
		if err := s.CreateSession(ctx, tc.hash, uid, tc.expiry); err != nil { t.Fatal(err) }
		got, err := s.SessionUser(ctx, tc.hash)
		if tc.valid && (err != nil || got != uid) { t.Fatalf("active session: %d %v",got,err) }
		if !tc.valid && !errors.Is(err, ErrNotFound) { t.Fatalf("expired session: %v",err) }
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE token=$1`, "active-test-digest"); err != nil { t.Fatal(err) }
	if _, err := s.SessionUser(ctx, "active-test-digest"); !errors.Is(err, ErrNotFound) { t.Fatalf("revoked session: %v",err) }
	if err := s.DeleteSession(ctx, "active-test-digest"); err != nil { t.Fatal(err) }
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE token=$1`, "active-test-digest").Scan(&count); err != nil || count != 0 { t.Fatalf("logout persistence: %d %v",count,err) }
}

func TestMoveAuthorizationAndCAS(t *testing.T) {
	s := securityStore(t)
	ctx := context.Background()
	ids := make([]int64,3)
	for i, name := range []string{"black","white","outsider"} {
		var err error
		ids[i], err = s.CreateUser(ctx,name,"test-only")
		if err != nil { t.Fatal(err) }
	}
	id, err := s.CreateGame(ctx,ids[0])
	if err != nil { t.Fatal(err) }
	board := make([]byte,361)
	if err := s.ApplyMove(ctx,id,ids[0],0,board); !errors.Is(err,ErrConflict) { t.Fatalf("waiting move: %v",err) }
	if err := s.JoinGame(ctx,id,ids[0]); !errors.Is(err,ErrConflict) { t.Fatalf("self join: %v",err) }
	if err := s.JoinGame(ctx,id,ids[1]); err != nil { t.Fatal(err) }
	g, err := s.GetGame(ctx,id)
	if err != nil { t.Fatal(err) }
	for _, uid := range []int64{ids[1],ids[2]} {
		if err := s.ApplyMove(ctx,id,uid,g.Version,board); !errors.Is(err,ErrConflict) { t.Fatalf("unauthorized move: %v",err) }
	}
	var wg sync.WaitGroup
	results := make(chan error,2)
	for i:=0;i<2;i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- s.ApplyMove(ctx,id,ids[0],g.Version,board) }()
	}
	wg.Wait()
	close(results)
	successes := 0
	for err := range results { if err == nil { successes++ } else if !errors.Is(err,ErrConflict) { t.Fatal(err) } }
	if successes != 1 { t.Fatalf("concurrent successes: %d",successes) }
	updated, err := s.GetGame(ctx,id)
	if err != nil { t.Fatal(err) }
	if updated.Turn != 1 || updated.Version != g.Version+1 { t.Fatal("incorrect transition") }
	if err := s.ApplyMove(ctx,id,ids[1],g.Version,board); !errors.Is(err,ErrConflict) { t.Fatalf("stale move: %v",err) }
	if _, err := s.Pool.Exec(ctx, `UPDATE games SET status='finished' WHERE id=$1`,id); err != nil { t.Fatal(err) }
	if err := s.ApplyMove(ctx,id,ids[1],updated.Version,board); !errors.Is(err,ErrConflict) { t.Fatalf("finished move: %v",err) }
	moves, err := s.Moves(ctx,id)
	if err != nil || len(moves)!=1 { t.Fatalf("history: %d %v",len(moves),err) }
}
