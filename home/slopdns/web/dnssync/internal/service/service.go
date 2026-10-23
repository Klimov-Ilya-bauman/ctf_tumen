package service

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"

	syncv1 "slopdns/web/gen/slopdns/sync/v1"

	"slopdns/web/dnssync/internal/hub"
	"slopdns/web/dnssync/internal/server"
	"slopdns/web/dnssync/internal/store"
	"slopdns/web/pkg/app"
	"slopdns/web/pkg/config"
	"slopdns/web/pkg/edkey"
	"slopdns/web/pkg/health"
	"slopdns/web/pkg/httpx"
	slopLog "slopdns/web/pkg/log"
	"slopdns/web/pkg/mtls"
	"slopdns/web/pkg/pg"
	"slopdns/web/pkg/syncproto"
)

const (
	Name           = "dns-sync"
	SigningKeyName = "backend-sync"
)

type Config struct {
	app.Base
	DatabaseURL      string
	DBConnectTimeout time.Duration
	DBMaxConns       int
	PKIDir           string
	GRPCAddr         string
	NodeIDs          []string
	Heartbeat        time.Duration
	PollInterval     time.Duration
	SendTimeout      time.Duration
	HelloTimeout     time.Duration
	SendQueue        int
	LagLogInterval   time.Duration
}

func LoadConfig(env *config.Env) (Config, error) {
	c := Config{Base: app.LoadBase(env)}
	c.DatabaseURL = env.Secret("DATABASE_URL", true)
	if c.DatabaseURL != "" && !strings.HasPrefix(c.DatabaseURL, "postgres://") && !strings.HasPrefix(c.DatabaseURL, "postgresql://") {
		env.Fail("DATABASE_URL", "must be a postgres:// URL")
	}
	c.DBConnectTimeout = env.Duration("DB_CONNECT_TIMEOUT", 30*time.Second, time.Second, 10*time.Minute)
	c.DBMaxConns = env.Int("DB_MAX_CONNS", 8, 2, 100)
	c.PKIDir = env.String("PKI_DIR", "/pki")
	c.GRPCAddr = env.Addr("GRPC_ADDR", ":9443")
	seen := map[string]bool{}
	for _, node := range env.List("DNS_NODE_IDS", []string{"dns1"}) {
		switch {
		case !mtls.ValidNodeID(node):
			env.Fail("DNS_NODE_IDS", "%q is not a valid node id (lowercase letters, digits and hyphens)", node)
		case seen[node]:
			env.Fail("DNS_NODE_IDS", "%q is listed twice", node)
		default:
			seen[node] = true
			c.NodeIDs = append(c.NodeIDs, node)
		}
	}
	c.Heartbeat = env.Duration("HEARTBEAT_INTERVAL", server.DefaultHeartbeat, 100*time.Millisecond, time.Minute)
	c.PollInterval = env.Duration("POLL_INTERVAL", hub.DefaultPollInterval, 50*time.Millisecond, time.Minute)
	c.SendTimeout = env.Duration("SEND_TIMEOUT", server.DefaultSendTimeout, 100*time.Millisecond, 10*time.Minute)
	c.HelloTimeout = env.Duration("HELLO_TIMEOUT", server.DefaultHelloTimeout, 100*time.Millisecond, 5*time.Minute)
	c.SendQueue = env.Int("SEND_QUEUE", server.DefaultQueueSize, 1, 4096)
	c.LagLogInterval = env.Duration("LAG_LOG_INTERVAL", server.DefaultLagLogInterval, time.Second, time.Hour)
	return c, env.Err()
}

type Keys struct {
	TLS    *mtls.Material
	Signer ed25519.PrivateKey
	Nodes  map[string]ed25519.PublicKey
}

func LoadKeys(dir string, nodes []string) (*Keys, error) {
	material, err := mtls.Load(mtls.FilesIn(dir, Name))
	if err != nil {
		return nil, fmt.Errorf("load mTLS material: %w", err)
	}
	signer, err := edkey.LoadPrivateKey(filepath.Join(dir, SigningKeyName+".key"))
	if err != nil {
		return nil, fmt.Errorf("load signing key: %w", err)
	}
	k := &Keys{TLS: material, Signer: signer, Nodes: map[string]ed25519.PublicKey{}}
	for _, node := range nodes {
		pub, err := edkey.LoadPublicKey(filepath.Join(dir, "dns-"+node+".pub"))
		if err != nil {
			return nil, fmt.Errorf("load public key of node %s: %w", node, err)
		}
		k.Nodes[node] = pub
	}
	return k, nil
}

func GRPCServer(srv *server.Server, material *mtls.Material) (*grpc.Server, error) {
	tlsCfg, err := mtls.ServerConfig(material, srv.VerifyPeer)
	if err != nil {
		return nil, err
	}
	g := grpc.NewServer(
		grpc.Creds(credentials.NewTLS(tlsCfg)),
		grpc.MaxRecvMsgSize(syncproto.MaxMessageSize),
		grpc.MaxSendMsgSize(syncproto.MaxMessageSize),
		grpc.KeepaliveParams(keepalive.ServerParameters{Time: 30 * time.Second, Timeout: 10 * time.Second}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: 5 * time.Second, PermitWithoutStream: true}),
	)
	syncv1.RegisterDnsSyncServiceServer(g, srv)
	return g, nil
}

func NewHandler(logger *slog.Logger, h *health.Handler) http.Handler {
	mux := http.NewServeMux()
	h.Mount(mux)
	mux.Handle("/", httpx.NotFoundHandler())
	return httpx.Chain(mux, slopLog.Middleware(logger, "/healthz", "/readyz"), httpx.Recover(logger))
}

func maxConns(n int) int32 {
	if n <= 0 || n > math.MaxInt32 {
		return 8
	}
	return int32(n)
}

func Serve(ctx context.Context, cfg Config, logger *slog.Logger) error {
	grpcLn, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		return err
	}
	httpLn, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		_ = grpcLn.Close()
		return err
	}
	return Run(ctx, cfg, logger, grpcLn, httpLn)
}

func Run(ctx context.Context, cfg Config, logger *slog.Logger, grpcLn, httpLn net.Listener) error {
	defer func() { _ = grpcLn.Close() }()
	defer func() { _ = httpLn.Close() }()
	keys, err := LoadKeys(cfg.PKIDir, cfg.NodeIDs)
	if err != nil {
		return err
	}
	pool, err := pg.Open(ctx, cfg.DatabaseURL, pg.Options{ConnectTimeout: cfg.DBConnectTimeout, MaxConns: maxConns(cfg.DBMaxConns), Logger: logger})
	if err != nil {
		return err
	}
	defer pool.Close()
	st := store.New(pool)
	notifier := hub.New(st, hub.Options{DSN: cfg.DatabaseURL, PollInterval: cfg.PollInterval, Logger: logger})
	srv, err := server.New(st, notifier, server.Options{
		Signer:         keys.Signer,
		NodeKeys:       keys.Nodes,
		Heartbeat:      cfg.Heartbeat,
		HelloTimeout:   cfg.HelloTimeout,
		SendTimeout:    cfg.SendTimeout,
		QueueSize:      cfg.SendQueue,
		RetryInterval:  cfg.PollInterval,
		LagLogInterval: cfg.LagLogInterval,
		Logger:         logger,
	})
	if err != nil {
		return err
	}
	grpcServer, err := GRPCServer(srv, keys.TLS)
	if err != nil {
		return err
	}
	h := health.New(logger, 0)
	h.Register("db", pg.Checker(pool))
	h.Register("listen", notifier.Check)
	h.RegisterDetails("nodes", func() any { return srv.Nodes() })
	h.RegisterDetails("change_log", func() any { return notifier.Stats() })

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		notifier.Run(ctx)
	}()
	go func() {
		defer wg.Done()
		srv.RunLagLogger(ctx)
	}()
	grpcErr := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		logger.InfoContext(ctx, "sync grpc server listening", slog.String("addr", grpcLn.Addr().String()), slog.Any("nodes", cfg.NodeIDs))
		if err := grpcServer.Serve(grpcLn); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			grpcErr <- err
			cancel()
		}
	}()
	httpErr := app.Serve(ctx, logger, app.NewServer(NewHandler(logger, h), logger), httpLn, app.DefaultShutdownTimeout)
	cancel()
	srv.Close()
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
	select {
	case err := <-grpcErr:
		return errors.Join(httpErr, err)
	default:
		return httpErr
	}
}

func Commands(lookup config.LookupFunc, logOut io.Writer) []app.Command {
	return []app.Command{
		{
			Name:  "serve",
			Usage: "run the dns-sync gRPC server for DNS nodes",
			Run: func(ctx context.Context, args []string) error {
				if err := app.NoArgs(args); err != nil {
					return err
				}
				cfg, err := LoadConfig(config.New(lookup))
				if err != nil {
					return err
				}
				return Serve(ctx, cfg, slopLog.New(logOut, cfg.LogLevel, Name))
			},
		},
		app.HealthcheckCommand(lookup),
	}
}
