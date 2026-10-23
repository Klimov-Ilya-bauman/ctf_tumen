package service

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"
	"slopdns/web/iam/internal/backendclient"
	"slopdns/web/iam/internal/core"
	"slopdns/web/iam/internal/grpcapi"
	"slopdns/web/iam/internal/httpapi"
	"slopdns/web/iam/internal/jobs"
	"slopdns/web/iam/internal/password"
	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/store/pgstore"
	"slopdns/web/iam/internal/totp"
	"slopdns/web/iam/migrations"
	"slopdns/web/pkg/app"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/config"
	"slopdns/web/pkg/edkey"
	"slopdns/web/pkg/health"
	"slopdns/web/pkg/httpx"
	slopLog "slopdns/web/pkg/log"
	"slopdns/web/pkg/mtls"
	"slopdns/web/pkg/pg"
)

const Name = "iam"

const DefaultGRPCAddr = ":9090"

type Config struct {
	app.Base
	DatabaseURL       string
	MigrateOnStart    bool
	DBConnectTimeout  time.Duration
	PKIDir            string
	GRPCAddr          string
	BackendAddr       string
	BackendTimeout    time.Duration
	TOTPKey           string
	AssertionKeyFile  string
	CookieSecure      bool
	ArgonConcurrency  int
	ArgonQueueTimeout time.Duration
	CleanupInterval   time.Duration
	TLSFiles          mtls.Files
}

func LoadConfig(env *config.Env) (Config, error) {
	c := Config{Base: app.LoadBase(env)}
	c.DatabaseURL = env.Secret("DATABASE_URL", true)
	if c.DatabaseURL != "" && !strings.HasPrefix(c.DatabaseURL, "postgres://") && !strings.HasPrefix(c.DatabaseURL, "postgresql://") {
		env.Fail("DATABASE_URL", "must be a postgres:// URL")
	}
	c.MigrateOnStart = env.Bool("MIGRATE_ON_START", true)
	c.DBConnectTimeout = env.Duration("DB_CONNECT_TIMEOUT", 30*time.Second, time.Second, 10*time.Minute)
	c.PKIDir = env.String("PKI_DIR", "/pki")
	c.GRPCAddr = env.Addr("GRPC_ADDR", DefaultGRPCAddr)
	c.BackendAddr = env.String("BACKEND_GRPC_ADDR", "backend:9090")
	if c.BackendAddr == "" || strings.ContainsAny(c.BackendAddr, " \t\r\n") {
		env.Fail("BACKEND_GRPC_ADDR", "must be a host:port address")
	}
	c.BackendTimeout = env.Duration("BACKEND_TIMEOUT", 3*time.Second, 100*time.Millisecond, time.Minute)
	c.TOTPKey = env.Secret("IAM_TOTP_KEY", false)
	c.AssertionKeyFile = env.String("IAM_ASSERTION_KEY_FILE", filepath.Join(c.PKIDir, "iam-assertion.key"))
	c.CookieSecure = env.Bool("SESSION_COOKIE_SECURE", false)
	c.ArgonConcurrency = env.Int("ARGON2_MAX_CONCURRENCY", 2, 1, 64)
	c.ArgonQueueTimeout = env.Duration("ARGON2_QUEUE_TIMEOUT", password.DefaultQueueTimeout, 10*time.Millisecond, time.Minute)
	c.CleanupInterval = env.Duration("CLEANUP_INTERVAL", jobs.DefaultCleanupConfig().Interval, time.Second, 24*time.Hour)
	c.TLSFiles = mtls.Files{
		CA:   env.String("TLS_CA_FILE", filepath.Join(c.PKIDir, "ca.crt")),
		Cert: env.String("TLS_CERT_FILE", filepath.Join(c.PKIDir, "iam.crt")),
		Key:  env.String("TLS_KEY_FILE", filepath.Join(c.PKIDir, "iam.key")),
	}
	return c, env.Err()
}

type keys struct {
	totp      []byte
	assertion ed25519.PrivateKey
	material  *mtls.Material
}

func loadKeys(cfg Config) (keys, error) {
	var k keys
	raw := cfg.TOTPKey
	if raw == "" {
		data, err := os.ReadFile(filepath.Join(cfg.PKIDir, "iam-totp.key"))
		if err != nil {
			return k, fmt.Errorf("IAM_TOTP_KEY is not set and %s cannot be read: %w", filepath.Join(cfg.PKIDir, "iam-totp.key"), err)
		}
		raw = string(data)
	}
	var err error
	if k.totp, err = totp.ParseKey(raw); err != nil {
		return k, fmt.Errorf("IAM_TOTP_KEY: %w", err)
	}
	if k.assertion, err = edkey.LoadPrivateKey(cfg.AssertionKeyFile); err != nil {
		return k, fmt.Errorf("assertion key: %w", err)
	}
	if k.material, err = mtls.Load(cfg.TLSFiles); err != nil {
		return k, fmt.Errorf("mTLS material: %w", err)
	}
	return k, nil
}

type Server struct {
	cfg     Config
	log     *slog.Logger
	handler http.Handler
	grpc    *grpc.Server
	cleaner *jobs.Cleaner
	backend *backendclient.Client
}

func NewServer(cfg Config, logger *slog.Logger, st store.Store, dbCheck health.Checker) (*Server, error) {
	k, err := loadKeys(cfg)
	if err != nil {
		return nil, err
	}
	hasher, err := password.NewHasher(password.Default, cfg.ArgonConcurrency, cfg.ArgonQueueTimeout)
	if err != nil {
		return nil, err
	}
	cipher, err := totp.NewCipher(k.totp)
	if err != nil {
		return nil, err
	}
	issuer, err := assertion.NewIssuer(k.assertion, assertion.DefaultTTL)
	if err != nil {
		return nil, err
	}
	pub, ok := k.assertion.Public().(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("assertion key has no Ed25519 public key")
	}
	verifier, err := assertion.NewVerifier(pub)
	if err != nil {
		return nil, err
	}
	bc, err := backendclient.Dial(cfg.BackendAddr, k.material)
	if err != nil {
		return nil, fmt.Errorf("backend client: %w", err)
	}
	coreCfg := core.DefaultConfig()
	coreCfg.BackendTimeout = cfg.BackendTimeout
	svc, err := core.New(core.Deps{Store: st, Hasher: hasher, Cipher: cipher, Issuer: issuer, Backend: bc, Logger: logger, Config: coreCfg})
	if err != nil {
		_ = bc.Close()
		return nil, err
	}
	h := health.New(logger, 0)
	h.Register("db", dbCheck)
	h.RegisterDetails("backend_grpc", func() any { return bc.State() })
	mux := http.NewServeMux()
	h.Mount(mux)
	httpapi.New(svc, verifier, logger, httpapi.Config{CookieSecure: cfg.CookieSecure}).Mount(mux)
	mux.Handle("/", httpx.NotFoundHandler())
	handler := httpx.Chain(mux, slopLog.Middleware(logger, "/healthz", "/readyz"), httpx.Recover(logger))
	tlsCfg, err := mtls.ServerConfig(k.material, mtls.AllowURIs(grpcapi.GatewayURI, grpcapi.BackendURI))
	if err != nil {
		_ = bc.Close()
		return nil, err
	}
	gs := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(tlsCfg)),
		grpc.ChainUnaryInterceptor(grpcapi.Logging(logger), grpcapi.Authorize(grpcapi.DefaultPolicy())),
		grpc.MaxRecvMsgSize(1<<20),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: 10 * time.Second, PermitWithoutStream: true}),
	)
	iamv1.RegisterIamServiceServer(gs, grpcapi.New(svc, logger))
	cleaner := jobs.NewCleaner(st, jobs.CleanupConfig{Interval: cfg.CleanupInterval}, logger, nil)
	return &Server{cfg: cfg, log: logger, handler: handler, grpc: gs, cleaner: cleaner, backend: bc}, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) Run(ctx context.Context, httpLn, grpcLn net.Listener) error {
	defer func() { _ = s.backend.Close() }()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(3)
	go func() {
		defer wg.Done()
		s.cleaner.Run(ctx)
	}()
	go func() {
		defer wg.Done()
		s.log.InfoContext(ctx, "grpc server listening", slog.String("addr", grpcLn.Addr().String()))
		if err := s.grpc.Serve(grpcLn); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			errs <- fmt.Errorf("grpc: %w", err)
			cancel()
		}
	}()
	go func() {
		defer wg.Done()
		if err := app.Serve(ctx, s.log, app.NewServer(s.handler, s.log), httpLn, app.DefaultShutdownTimeout); err != nil {
			errs <- fmt.Errorf("http: %w", err)
		}
		cancel()
	}()
	<-ctx.Done()
	stopped := make(chan struct{})
	go func() {
		s.grpc.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(app.DefaultShutdownTimeout):
		s.grpc.Stop()
	}
	wg.Wait()
	close(errs)
	var all []error
	for err := range errs {
		all = append(all, err)
	}
	return errors.Join(all...)
}

func openDB(ctx context.Context, cfg Config, logger *slog.Logger, migrate bool) (*pgxpool.Pool, error) {
	pool, err := pg.Open(ctx, cfg.DatabaseURL, pg.Options{ConnectTimeout: cfg.DBConnectTimeout, Logger: logger})
	if err != nil {
		return nil, err
	}
	if migrate {
		res, err := pg.Migrate(ctx, pool, migrations.FS())
		if err != nil {
			pool.Close()
			return nil, err
		}
		logger.InfoContext(ctx, "migrations applied", slog.Int64("version", res.Version), slog.Any("applied", res.Applied))
	}
	return pool, nil
}

func Serve(ctx context.Context, cfg Config, logger *slog.Logger) error {
	pool, err := openDB(ctx, cfg, logger, cfg.MigrateOnStart)
	if err != nil {
		return err
	}
	defer pool.Close()
	srv, err := NewServer(cfg, logger, pgstore.New(pool), pg.Checker(pool))
	if err != nil {
		return err
	}
	var lc net.ListenConfig
	httpLn, err := lc.Listen(ctx, "tcp", cfg.HTTPAddr)
	if err != nil {
		_ = srv.backend.Close()
		return err
	}
	grpcLn, err := lc.Listen(ctx, "tcp", cfg.GRPCAddr)
	if err != nil {
		_ = httpLn.Close()
		_ = srv.backend.Close()
		return err
	}
	return srv.Run(ctx, httpLn, grpcLn)
}

func Migrate(ctx context.Context, cfg Config, logger *slog.Logger) error {
	pool, err := openDB(ctx, cfg, logger, true)
	if err != nil {
		return err
	}
	pool.Close()
	return nil
}

func Commands(lookup config.LookupFunc, logOut io.Writer) []app.Command {
	load := func() (Config, *slog.Logger, error) {
		cfg, err := LoadConfig(config.New(lookup))
		if err != nil {
			return cfg, nil, err
		}
		return cfg, slopLog.New(logOut, cfg.LogLevel, Name), nil
	}
	return []app.Command{
		{
			Name:  "serve",
			Usage: "run the IAM service",
			Run: func(ctx context.Context, args []string) error {
				if err := app.NoArgs(args); err != nil {
					return err
				}
				cfg, logger, err := load()
				if err != nil {
					return err
				}
				return Serve(ctx, cfg, logger)
			},
		},
		{
			Name:  "migrate",
			Usage: "apply database migrations and exit",
			Run: func(ctx context.Context, args []string) error {
				if err := app.NoArgs(args); err != nil {
					return err
				}
				cfg, logger, err := load()
				if err != nil {
					return err
				}
				return Migrate(ctx, cfg, logger)
			},
		},
		app.HealthcheckCommand(lookup),
	}
}
