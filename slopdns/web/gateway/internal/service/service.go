package service

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"slopdns/web/gateway/internal/iamclient"
	"slopdns/web/gateway/internal/proxy"
	"slopdns/web/gateway/internal/ratelimit"
	iamv1 "slopdns/web/gen/slopdns/iam/v1"
	"slopdns/web/pkg/app"
	"slopdns/web/pkg/config"
	"slopdns/web/pkg/health"
	"slopdns/web/pkg/httpx"
	slopLog "slopdns/web/pkg/log"
	"slopdns/web/pkg/mtls"
)

const Name = "gateway"

const (
	DefaultIAMGRPCAddr    = "iam:9090"
	DefaultIAMHTTPURL     = "http://iam:8080"
	DefaultBackendHTTPURL = "http://backend:8080"
	DefaultRateLimitRPS   = 50.0
	DefaultRateLimitBurst = 100
	backendProbeTimeout   = 500 * time.Millisecond
)

type Config struct {
	app.Base
	PKIDir            string
	IAMGRPCAddr       string
	IAMServerName     string
	IAMHTTPURL        *url.URL
	BackendHTTPURL    *url.URL
	RateLimitRPS      float64
	RateLimitBurst    int
	MaxBodyBytes      int64
	IntrospectTimeout time.Duration
	UpstreamTimeout   time.Duration
}

func LoadConfig(env *config.Env) (Config, error) {
	c := Config{Base: app.LoadBase(env)}
	c.PKIDir = env.String("PKI_DIR", "/pki")
	c.IAMGRPCAddr = env.Addr("IAM_GRPC_ADDR", DefaultIAMGRPCAddr)
	c.IAMServerName = env.String("IAM_GRPC_SERVER_NAME", "")
	c.IAMHTTPURL = upstreamURL(env, "IAM_HTTP_URL", DefaultIAMHTTPURL)
	c.BackendHTTPURL = upstreamURL(env, "BACKEND_HTTP_URL", DefaultBackendHTTPURL)
	c.RateLimitRPS = env.Float("RATE_LIMIT_RPS", DefaultRateLimitRPS, 0.01, 1e6)
	c.RateLimitBurst = env.Int("RATE_LIMIT_BURST", DefaultRateLimitBurst, 1, 1_000_000)
	c.MaxBodyBytes = int64(env.Int("MAX_BODY_BYTES", int(httpx.DefaultMaxBodyBytes), 1024, 64<<20))
	c.IntrospectTimeout = env.Duration("INTROSPECT_TIMEOUT", iamclient.DefaultTimeout, 100*time.Millisecond, 30*time.Second)
	c.UpstreamTimeout = env.Duration("UPSTREAM_TIMEOUT", proxy.DefaultUpstreamTimeout, time.Second, 5*time.Minute)
	return c, env.Err()
}

func upstreamURL(env *config.Env, name, def string) *url.URL {
	raw := env.URL(name, def, true, "http")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		u, _ = url.Parse(def)
		return u
	}
	if (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		env.Fail(name, "must be scheme://host:port without path, query or credentials")
		u, _ = url.Parse(def)
		return u
	}
	u.Path = ""
	return u
}

type Deps struct {
	Introspector *iamclient.Client
	Health       *health.Handler
	Handler      http.Handler
}

func Build(cfg Config, logger *slog.Logger, rpc iamv1.IamServiceClient) (*Deps, error) {
	client := iamclient.New(rpc, cfg.IntrospectTimeout)
	h := health.New(logger, 0)
	probe := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	iamReady := cfg.IAMHTTPURL.JoinPath("/readyz").String()
	backendReady := cfg.BackendHTTPURL.JoinPath("/readyz").String()
	h.Register("iam", func(ctx context.Context) error {
		if err := client.Ping(ctx); err != nil {
			return fmt.Errorf("introspect: %w", err)
		}
		return probeURL(ctx, probe, iamReady)
	})
	h.RegisterDetails("backend", func() any {
		ctx, cancel := context.WithTimeout(context.Background(), backendProbeTimeout)
		defer cancel()
		if err := probeURL(ctx, probe, backendReady); err != nil {
			return health.StatusUnavailable
		}
		return health.StatusOK
	})
	mux := http.NewServeMux()
	h.Mount(mux)
	handler, err := proxy.New(proxy.Config{
		IAMURL:          cfg.IAMHTTPURL,
		BackendURL:      cfg.BackendHTTPURL,
		MaxBodyBytes:    cfg.MaxBodyBytes,
		UpstreamTimeout: cfg.UpstreamTimeout,
	}, client, ratelimit.New(cfg.RateLimitRPS, cfg.RateLimitBurst, nil), logger, mux)
	if err != nil {
		return nil, err
	}
	return &Deps{Introspector: client, Health: h, Handler: handler}, nil
}

func probeURL(ctx context.Context, c *http.Client, u string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned HTTP %d", u, resp.StatusCode)
	}
	return nil
}

func Serve(ctx context.Context, cfg Config, logger *slog.Logger) error {
	material, err := mtls.Load(mtls.FilesIn(cfg.PKIDir, Name))
	if err != nil {
		return fmt.Errorf("load mTLS material: %w", err)
	}
	conn, err := iamclient.Dial(cfg.IAMGRPCAddr, cfg.IAMServerName, material)
	if err != nil {
		return fmt.Errorf("dial iam: %w", err)
	}
	defer func() { _ = conn.Close() }()
	deps, err := Build(cfg, logger, iamv1.NewIamServiceClient(conn))
	if err != nil {
		return err
	}
	return app.ListenAndServe(ctx, logger, cfg.HTTPAddr, deps.Handler)
}

func Commands(lookup config.LookupFunc, logOut io.Writer) []app.Command {
	return []app.Command{
		{
			Name:  "serve",
			Usage: "run the API gateway",
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
		app.NoMigrationsCommand(),
		app.HealthcheckCommand(lookup),
	}
}
