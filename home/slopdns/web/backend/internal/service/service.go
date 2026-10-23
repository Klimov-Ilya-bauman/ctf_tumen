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
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"

	backendv1 "slopdns/web/gen/slopdns/backend/v1"
	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/api"
	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/conv"
	"slopdns/web/backend/internal/core"
	"slopdns/web/backend/internal/dnsname"
	"slopdns/web/backend/internal/grpcapi"
	"slopdns/web/backend/internal/jobs"
	"slopdns/web/backend/internal/outbox"
	"slopdns/web/backend/internal/reconcile"
	"slopdns/web/backend/internal/store"
	"slopdns/web/backend/migrations"
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

const Name = "backend"

type JobConfig struct {
	Enabled            bool
	ExpireInterval     time.Duration
	OutboxInterval     time.Duration
	PruneInterval      time.Duration
	ReconcileInterval  time.Duration
	ChangeLogRetention time.Duration
	OutboxRetention    time.Duration
	ReconcileGrace     time.Duration
}

type Config struct {
	app.Base
	DatabaseURL      string
	MigrateOnStart   bool
	DBConnectTimeout time.Duration
	DBMaxConns       int
	PKIDir           string
	GRPCAddr         string
	IAMAddr          string
	AssertionKeys    []string
	AuthzCacheSize   int
	AuthzCacheTTL    time.Duration
	UserCacheSize    int
	UserCacheTTL     time.Duration
	Zone             core.ZoneDefaults
	Limits           core.Limits
	Jobs             JobConfig
}

func hostConfig(env *config.Env, name, def string) string {
	v := env.String(name, def)
	n, err := dnsname.ParseHost(v, false)
	if err != nil {
		env.Fail(name, "must be a valid domain name: %v", err)
		return def
	}
	return n
}

func LoadConfig(env *config.Env) (Config, error) {
	c := Config{Base: app.LoadBase(env)}
	c.DatabaseURL = env.Secret("DATABASE_URL", true)
	if c.DatabaseURL != "" && !strings.HasPrefix(c.DatabaseURL, "postgres://") && !strings.HasPrefix(c.DatabaseURL, "postgresql://") {
		env.Fail("DATABASE_URL", "must be a postgres:// URL")
	}
	c.MigrateOnStart = env.Bool("MIGRATE_ON_START", true)
	c.DBConnectTimeout = env.Duration("DB_CONNECT_TIMEOUT", 30*time.Second, time.Second, 10*time.Minute)
	c.DBMaxConns = env.Int("DB_MAX_CONNS", 16, 2, 1000)
	c.PKIDir = env.String("PKI_DIR", "/pki")
	c.GRPCAddr = env.Addr("GRPC_ADDR", ":9090")
	c.IAMAddr = env.Addr("IAM_GRPC_ADDR", "iam:9090")
	c.AssertionKeys = env.List("ASSERTION_PUBLIC_KEYS", []string{filepath.Join(c.PKIDir, "iam-assertion.pub")})
	c.AuthzCacheSize = env.Int("AUTHZ_CACHE_SIZE", authz.DefaultSize, 1, 10000000)
	c.AuthzCacheTTL = env.Duration("AUTHZ_CACHE_TTL", authz.DefaultTTL, time.Second, time.Hour)
	c.UserCacheSize = env.Int("USER_CACHE_SIZE", core.DefaultUserCacheSize, 1, 10000000)
	c.UserCacheTTL = env.Duration("USER_CACHE_TTL", core.DefaultUserCacheTTL, time.Second, 24*time.Hour)
	suffix := env.String("USER_ZONE_SUFFIX", "slop")
	if s, err := dnsname.NormalizeSuffix(suffix); err != nil {
		env.Fail("USER_ZONE_SUFFIX", "must be a valid domain name: %v", err)
	} else {
		c.Zone.Suffix = s
	}
	c.Zone.DefaultTTL = conv.I32(int64(env.Int("ZONE_DEFAULT_TTL", 3600, 0, core.MaxTTL)))
	c.Zone.MName = hostConfig(env, "SOA_MNAME", "ns1.slopdns.slop.")
	c.Zone.RName = hostConfig(env, "SOA_RNAME", "hostmaster.slopdns.slop.")
	c.Zone.Refresh = conv.I32(int64(env.Int("SOA_REFRESH", 3600, 60, core.MaxTTL)))
	c.Zone.Retry = conv.I32(int64(env.Int("SOA_RETRY", 900, 60, core.MaxTTL)))
	c.Zone.Expire = conv.I32(int64(env.Int("SOA_EXPIRE", 1209600, 60, core.MaxTTL)))
	c.Zone.Minimum = conv.I32(int64(env.Int("SOA_MINIMUM", 300, 0, 86400)))
	if c.Zone.Expire <= c.Zone.Refresh || c.Zone.Expire <= c.Zone.Retry {
		env.Fail("SOA_EXPIRE", "must be greater than SOA_REFRESH and SOA_RETRY")
	}
	for _, ns := range env.List("ZONE_NAMESERVERS", []string{"ns1.slopdns.slop."}) {
		n, err := dnsname.ParseHost(ns, false)
		if err != nil {
			env.Fail("ZONE_NAMESERVERS", "%q is not a valid domain name", ns)
			continue
		}
		c.Zone.NameServers = append(c.Zone.NameServers, n)
	}
	for _, r := range env.List("RESERVED_ZONE_NAMES", nil) {
		n, err := dnsname.ParseHost(r, false)
		if err != nil {
			env.Fail("RESERVED_ZONE_NAMES", "%q is not a valid domain name", r)
			continue
		}
		c.Zone.Reserved = append(c.Zone.Reserved, n)
	}
	def := core.DefaultLimits()
	c.Limits.MaxZonesPerOrg = env.Int("MAX_ZONES_PER_ORG", def.MaxZonesPerOrg, 1, 1000000)
	c.Limits.MaxRecordsPerZone = env.Int("MAX_RECORDS_PER_ZONE", def.MaxRecordsPerZone, 1, 1000000)
	c.Limits.MaxOrgsPerUser = env.Int("MAX_ORGS_PER_USER", def.MaxOrgsPerUser, 1, 1000000)
	c.Limits.MaxPendingInvitationsPerOrg = env.Int("MAX_PENDING_INVITATIONS_PER_ORG", def.MaxPendingInvitationsPerOrg, 1, 1000000)
	c.Limits.MaxZoneBytes = int64(env.Int("MAX_ZONE_BYTES", int(def.MaxZoneBytes), 1024, 15<<20))
	c.Jobs.Enabled = env.Bool("JOBS_ENABLED", true)
	c.Jobs.ExpireInterval = env.Duration("JOB_EXPIRE_INTERVAL", time.Minute, time.Second, 24*time.Hour)
	c.Jobs.OutboxInterval = env.Duration("JOB_OUTBOX_INTERVAL", 2*time.Second, 100*time.Millisecond, time.Hour)
	c.Jobs.PruneInterval = env.Duration("JOB_PRUNE_INTERVAL", 10*time.Minute, time.Second, 24*time.Hour)
	c.Jobs.ReconcileInterval = env.Duration("JOB_RECONCILE_INTERVAL", 10*time.Minute, time.Second, 24*time.Hour)
	c.Jobs.ChangeLogRetention = env.Duration("CHANGE_LOG_RETENTION", 24*time.Hour, time.Minute, 90*24*time.Hour)
	c.Jobs.OutboxRetention = env.Duration("OUTBOX_RETENTION", 7*24*time.Hour, time.Minute, 90*24*time.Hour)
	c.Jobs.ReconcileGrace = env.Duration("RECONCILE_GRACE", reconcile.DefaultGrace, 0, 24*time.Hour)
	return c, env.Err()
}

type Deps struct {
	Store      *store.Store
	IAM        iamv1.IamServiceClient
	Authz      *authz.Cache
	Dispatcher *outbox.Dispatcher
	Reconciler *reconcile.Reconciler
	Core       *core.Service
}

func NewDeps(pool *pgxpool.Pool, iam iamv1.IamServiceClient, cfg Config, logger *slog.Logger) *Deps {
	st := store.New(pool)
	cache := authz.NewCache(iam, cfg.AuthzCacheTTL, cfg.AuthzCacheSize)
	d := outbox.NewDispatcher(st, iam, logger)
	d.OnApplied(cache.Invalidate)
	svc := core.New(st, iam, cache, d, logger, cfg.Zone)
	svc.SetUserCache(cfg.UserCacheSize, cfg.UserCacheTTL)
	svc.SetLimits(cfg.Limits)
	rec := reconcile.New(st, iam, logger)
	rec.SetGrace(cfg.Jobs.ReconcileGrace)
	return &Deps{Store: st, IAM: iam, Authz: cache, Dispatcher: d, Reconciler: rec, Core: svc}
}

func (d *Deps) Jobs(cfg JobConfig) []jobs.Job {
	return []jobs.Job{
		{Name: "expire", Interval: cfg.ExpireInterval, Run: d.Core.Expire},
		{Name: "outbox", Interval: cfg.OutboxInterval, Run: d.Dispatcher.Run},
		{Name: "prune", Interval: cfg.PruneInterval, Run: func(ctx context.Context) error {
			now := time.Now()
			q := d.Store.Q()
			if _, err := q.PruneChangeLog(ctx, now.Add(-cfg.ChangeLogRetention)); err != nil {
				return err
			}
			_, err := q.PruneOutbox(ctx, now.Add(-cfg.OutboxRetention))
			return err
		}},
		{Name: "reconcile", Interval: cfg.ReconcileInterval, Run: d.Reconciler.Run},
	}
}

func NewHandler(logger *slog.Logger, h *health.Handler, apiHandler *api.Handler, verifier *assertion.Verifier) http.Handler {
	mux := http.NewServeMux()
	h.Mount(mux)
	if apiHandler != nil {
		apiHandler.Mount(mux, verifier)
	}
	mux.Handle("/", httpx.NotFoundHandler())
	return httpx.Chain(mux, slopLog.Middleware(logger, "/healthz", "/readyz"), httpx.Recover(logger))
}

func openDB(ctx context.Context, cfg Config, logger *slog.Logger, migrate bool) (*pgxpool.Pool, error) {
	pool, err := pg.Open(ctx, cfg.DatabaseURL, pg.Options{ConnectTimeout: cfg.DBConnectTimeout, MaxConns: conv.I32(int64(cfg.DBMaxConns)), Logger: logger})
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

func loadVerifier(paths []string) (*assertion.Verifier, error) {
	keys := map[string]ed25519.PublicKey{}
	for _, p := range paths {
		pub, err := edkey.LoadPublicKey(p)
		if err != nil {
			return nil, fmt.Errorf("assertion public key %s: %w", p, err)
		}
		keys[assertion.KeyID(pub)] = pub
	}
	return assertion.NewKeySetVerifier(keys)
}

func dialIAM(cfg Config, material *mtls.Material) (*grpc.ClientConn, error) {
	host, _, err := net.SplitHostPort(cfg.IAMAddr)
	if err != nil {
		return nil, err
	}
	tlsCfg, err := mtls.ClientConfig(material, host, mtls.AllowURIs(mtls.ServiceURI("iam")))
	if err != nil {
		return nil, err
	}
	return grpc.NewClient(cfg.IAMAddr, grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)))
}

func Serve(ctx context.Context, cfg Config, logger *slog.Logger) error {
	material, err := mtls.Load(mtls.FilesIn(cfg.PKIDir, Name))
	if err != nil {
		return fmt.Errorf("load mTLS material: %w", err)
	}
	verifier, err := loadVerifier(cfg.AssertionKeys)
	if err != nil {
		return err
	}
	pool, err := openDB(ctx, cfg, logger, cfg.MigrateOnStart)
	if err != nil {
		return err
	}
	defer pool.Close()
	conn, err := dialIAM(cfg, material)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	deps := NewDeps(pool, iamv1.NewIamServiceClient(conn), cfg, logger)

	h := health.New(logger, 0)
	h.Register("db", pg.Checker(pool))
	h.RegisterDetails("iam", func() any { return conn.GetState().String() })
	h.RegisterDetails("iam_outbox", func() any { return deps.Dispatcher.Stats() })
	handler := NewHandler(logger, h, api.New(deps.Core, logger), verifier)

	serverTLS, err := mtls.ServerConfig(material, mtls.AllowURIs(mtls.ServiceURI("iam")))
	if err != nil {
		return err
	}
	grpcServer := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)))
	backendv1.RegisterBackendServiceServer(grpcServer, grpcapi.New(deps.Core, logger))
	ln, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		return err
	}
	return run(ctx, logger, cfg, handler, grpcServer, ln, deps, pool)
}

func run(ctx context.Context, logger *slog.Logger, cfg Config, handler http.Handler, grpcServer *grpc.Server, ln net.Listener, deps *Deps, pool *pgxpool.Pool) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	grpcErr := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		logger.InfoContext(ctx, "grpc server listening", slog.String("addr", ln.Addr().String()))
		if err := grpcServer.Serve(ln); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			grpcErr <- err
			cancel()
		}
	}()
	var jobsWG *sync.WaitGroup
	if cfg.Jobs.Enabled {
		jobsWG = jobs.NewRunner(pool, logger, deps.Jobs(cfg.Jobs)...).Start(ctx)
	}
	httpErr := app.ListenAndServe(ctx, logger, cfg.HTTPAddr, handler)
	cancel()
	stopped := make(chan struct{})
	go func() {
		grpcServer.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(app.DefaultShutdownTimeout):
		grpcServer.Stop()
	}
	wg.Wait()
	if jobsWG != nil {
		jobsWG.Wait()
	}
	select {
	case err := <-grpcErr:
		return errors.Join(httpErr, err)
	default:
		return httpErr
	}
}

func Migrate(ctx context.Context, cfg Config, logger *slog.Logger) error {
	pool, err := openDB(ctx, cfg, logger, true)
	if err != nil {
		return err
	}
	pool.Close()
	return nil
}

type BootstrapConfig struct {
	Address string
	Zone    string
}

func LoadBootstrapConfig(env *config.Env, cfg Config) (BootstrapConfig, error) {
	b := BootstrapConfig{Address: env.Required("INFRA_NS_ADDRESS")}
	if b.Address != "" && !core.ValidIPv4(b.Address) {
		env.Fail("INFRA_NS_ADDRESS", "must be a dotted-quad IPv4 address")
	}
	zone, err := core.InfraZoneName(cfg.Zone, env.String("INFRA_ZONE", ""))
	if err != nil {
		env.Fail("INFRA_ZONE", "%v", err)
	}
	b.Zone = zone
	return b, env.Err()
}

func Bootstrap(ctx context.Context, cfg Config, b BootstrapConfig, logger *slog.Logger) error {
	pool, err := openDB(ctx, cfg, logger, false)
	if err != nil {
		return err
	}
	defer pool.Close()
	svc := core.New(store.New(pool), nil, nil, nil, logger, cfg.Zone)
	res, err := svc.BootstrapInfra(ctx, b.Zone, b.Address)
	if err != nil {
		return err
	}
	logger.InfoContext(ctx, "infrastructure zone bootstrap finished", slog.String("zone", res.Zone), slog.String("zone_id", res.ZoneID), slog.String("org_id", res.OrgID),
		slog.Bool("org_created", res.OrgCreated), slog.Bool("zone_created", res.ZoneCreated), slog.Any("updated", res.Updated), slog.Bool("changed", res.Changed()))
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
			Usage: "run the Backend service",
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
		{
			Name:  "bootstrap-infra",
			Usage: "create or update the service infrastructure zone (INFRA_NS_ADDRESS, optional INFRA_ZONE) and exit",
			Run: func(ctx context.Context, args []string) error {
				if err := app.NoArgs(args); err != nil {
					return err
				}
				cfg, logger, err := load()
				if err != nil {
					return err
				}
				b, err := LoadBootstrapConfig(config.New(lookup), cfg)
				if err != nil {
					return err
				}
				return Bootstrap(ctx, cfg, b, logger)
			},
		},
		app.HealthcheckCommand(lookup),
	}
}
