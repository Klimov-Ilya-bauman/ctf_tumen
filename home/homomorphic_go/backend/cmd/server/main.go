package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"homomorphicgo/auth"
	"homomorphicgo/httpapi"
	"homomorphicgo/store"
)

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	st, err := store.Open(ctx, dsn)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	cancel()

	ttl := 12 * time.Hour
	if value := os.Getenv("SESSION_TTL"); value != "" {
		var err error
		ttl, err = time.ParseDuration(value)
		if err != nil || ttl < time.Second {
			log.Fatal("SESSION_TTL must be a positive duration of at least 1s")
		}
	}
	secureCookies := true
	if value := os.Getenv("SESSION_COOKIE_SECURE"); value != "" {
		var err error
		secureCookies, err = strconv.ParseBool(value)
		if err != nil {
			log.Fatal("SESSION_COOKIE_SECURE must be true or false")
		}
	}
	api := &httpapi.API{Store: st, Tokens: auth.NewTokens(), SessionTTL: ttl, SecureCookies: secureCookies, AllowOrigin: os.Getenv("ALLOW_ORIGIN")}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.Handle("/", http.TimeoutHandler(api.Routes(), 15*time.Second, `{"error":"request timeout"}`))

	srv := &http.Server{Addr: addr, Handler: mux,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	maintenance, stopMaintenance := context.WithCancel(context.Background())
	defer stopMaintenance()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-maintenance.Done():
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(maintenance, 5*time.Second)
				if err := st.PurgeSessions(ctx); err != nil && maintenance.Err() == nil {
					log.Print("session cleanup failed")
				}
				cancel()
			}
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-sig
		sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer scancel()
		if err := srv.Shutdown(sctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
}
