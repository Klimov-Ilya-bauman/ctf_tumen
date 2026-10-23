package proxy

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"slopdns/web/gateway/internal/iamclient"
	"slopdns/web/gateway/internal/ratelimit"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/httpx"
	slopLog "slopdns/web/pkg/log"
)

const (
	DefaultUpstreamTimeout = 30 * time.Second
	DefaultDialTimeout     = 5 * time.Second
	MaxTokenLength         = 512
	maxLoggedPath          = 256
)

type Introspector interface {
	Introspect(ctx context.Context, token string) (iamclient.Identity, error)
}

type Limiter interface {
	Allow(key string) (bool, time.Duration)
}

type Config struct {
	IAMURL          *url.URL
	BackendURL      *url.URL
	MaxBodyBytes    int64
	UpstreamTimeout time.Duration
	DialTimeout     time.Duration
	Transport       http.RoundTripper
}

type Handler struct {
	cfg          Config
	introspector Introspector
	limiter      Limiter
	log          *slog.Logger
	health       http.Handler
	proxies      map[Upstream]http.Handler
}

type state struct {
	upstream  Upstream
	principal string
	assertion string
	body      *limitedBody
}

type stateKey struct{}

func stateFrom(ctx context.Context) *state {
	if st, ok := ctx.Value(stateKey{}).(*state); ok {
		return st
	}
	return &state{}
}

func New(cfg Config, in Introspector, lim Limiter, logger *slog.Logger, health http.Handler) (http.Handler, error) {
	if cfg.IAMURL == nil || cfg.BackendURL == nil {
		return nil, errors.New("proxy: upstream URLs are required")
	}
	if in == nil || lim == nil {
		return nil, errors.New("proxy: introspector and limiter are required")
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = httpx.DefaultMaxBodyBytes
	}
	if cfg.UpstreamTimeout <= 0 {
		cfg.UpstreamTimeout = DefaultUpstreamTimeout
	}
	if cfg.DialTimeout <= 0 {
		cfg.DialTimeout = DefaultDialTimeout
	}
	if cfg.Transport == nil {
		cfg.Transport = NewTransport(cfg.DialTimeout, cfg.UpstreamTimeout)
	}
	if health == nil {
		health = httpx.NotFoundHandler()
	}
	h := &Handler{cfg: cfg, introspector: in, limiter: lim, log: logger, health: health}
	h.proxies = map[Upstream]http.Handler{
		UpstreamIAM:     h.newReverseProxy(UpstreamIAM, cfg.IAMURL),
		UpstreamBackend: h.newReverseProxy(UpstreamBackend, cfg.BackendURL),
	}
	return httpx.Chain(http.HandlerFunc(h.serve), slopLog.RequestIDMiddleware, h.accessLog, httpx.Recover(logger), securityHeaders), nil
}

func NewTransport(dialTimeout, responseTimeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy:                  nil,
		DialContext:            (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:           256,
		MaxIdleConnsPerHost:    128,
		IdleConnTimeout:        90 * time.Second,
		ResponseHeaderTimeout:  responseTimeout,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: 64 << 10,
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr := w.Header()
		hdr.Set("Cache-Control", "no-store")
		hdr.Set("X-Content-Type-Options", "nosniff")
		hdr.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r.Context())
	if !CanonicalRequestURI(r.RequestURI) {
		httpx.WriteError(w, httpx.BadRequest("non-canonical request path"))
		return
	}
	if !CanonicalQuery(r.URL.RawQuery) {
		httpx.WriteError(w, httpx.BadRequest("malformed query string"))
		return
	}
	if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
		h.health.ServeHTTP(w, r)
		return
	}
	up, ok := Route(r.URL.Path)
	if !ok {
		httpx.WriteError(w, httpx.NotFound("not found"))
		return
	}
	if !allowedMethods[r.Method] {
		httpx.MethodNotAllowed().ServeHTTP(w, r)
		return
	}
	st.upstream = up
	StripInbound(r.Header)
	if r.ContentLength > h.cfg.MaxBodyBytes {
		httpx.WriteError(w, httpx.BadRequest("request body is too large"))
		return
	}
	if r.Body != nil && r.Body != http.NoBody {
		st.body = &limitedBody{ReadCloser: http.MaxBytesReader(w, r.Body, h.cfg.MaxBodyBytes)}
		r.Body = st.body
	}
	if !IsPublic(r.URL.Path) {
		if herr := h.authenticate(r, st); herr != nil {
			if herr.Status >= 500 {
				h.log.WarnContext(r.Context(), "authentication unavailable", slog.Any("error", herr.Unwrap()))
			}
			httpx.WriteError(w, herr)
			return
		}
	}
	h.proxies[up].ServeHTTP(w, r)
}

func (h *Handler) authenticate(r *http.Request, st *state) *httpx.Error {
	token, fromCookie, ok := Credentials(r)
	if !ok {
		return httpx.Unauthenticated("authentication required")
	}
	id, err := h.introspector.Introspect(r.Context(), token)
	switch {
	case errors.Is(err, iamclient.ErrInactive):
		return httpx.Unauthenticated("authentication required")
	case err != nil:
		return httpx.Unavailable("authentication service unavailable").WithCause(err)
	}
	st.principal = id.Key()
	if allowed, wait := h.limiter.Allow(id.Key()); !allowed {
		return httpx.RateLimited(ratelimit.RetryAfterSeconds(wait))
	}
	if fromCookie && IsMutating(r.Method) {
		v := r.Header.Values(CSRFHeader)
		if len(v) != 1 || v[0] != "1" {
			return httpx.NewError(http.StatusForbidden, httpx.CodeCSRFRequired, "X-SlopDNS-CSRF: 1 header is required")
		}
	}
	st.assertion = id.Assertion
	return nil
}

func Credentials(r *http.Request) (string, bool, bool) {
	auth := r.Header.Values("Authorization")
	if len(auth) > 1 {
		return "", false, false
	}
	if len(auth) == 1 {
		scheme, token, found := strings.Cut(auth[0], " ")
		if !found || !strings.EqualFold(scheme, "Bearer") || !validToken(token) || !bearerToken(token) {
			return "", false, false
		}
		return token, false, true
	}
	cookies := r.CookiesNamed(CookieName)
	if len(cookies) != 1 || !validToken(cookies[0].Value) || !strings.HasPrefix(cookies[0].Value, SessionTokenPrefix) {
		return "", true, false
	}
	return cookies[0].Value, true, true
}

func bearerToken(t string) bool {
	return strings.HasPrefix(t, UserTokenPrefix) || strings.HasPrefix(t, ServiceAccountTokenPrefix)
}

func validToken(t string) bool {
	if t == "" || len(t) > MaxTokenLength {
		return false
	}
	for i := 0; i < len(t); i++ {
		if t[i] <= ' ' || t[i] >= 0x7f {
			return false
		}
	}
	return true
}

func StripInbound(hdr http.Header) {
	hdr.Del(assertion.Header)
	hdr.Del("Forwarded")
	hdr.Del("X-Forwarded-Host")
}

var forwardedHeaders = map[Upstream][]string{
	UpstreamIAM:     {"Authorization", "Cookie", RealIPHeader, slopLog.RequestIDHeader},
	UpstreamBackend: {RealIPHeader, slopLog.RequestIDHeader},
}

func (h *Handler) newReverseProxy(name Upstream, target *url.URL) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.RawQuery = pr.In.URL.RawQuery
			for _, k := range forwardedHeaders[name] {
				if v := pr.In.Header.Values(k); len(v) > 0 {
					pr.Out.Header[k] = append([]string(nil), v...)
				}
			}
			if name != UpstreamIAM {
				pr.Out.Header.Del("Authorization")
				pr.Out.Header.Del("Cookie")
			}
			StripInbound(pr.Out.Header)
			pr.Out.Header.Del("Upgrade")
			pr.Out.Header.Del("Connection")
			if st := stateFrom(pr.In.Context()); st.assertion != "" {
				pr.Out.Header.Set(assertion.Header, st.assertion)
			}
		},
		Transport: h.cfg.Transport,
		ModifyResponse: func(resp *http.Response) error {
			for _, k := range []string{assertion.Header, "Cache-Control", "X-Content-Type-Options", "Referrer-Policy", slopLog.RequestIDHeader, "Server"} {
				resp.Header.Del(k)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			st := stateFrom(r.Context())
			if st.body != nil && st.body.exceeded.Load() {
				httpx.WriteError(w, httpx.BadRequest("request body is too large"))
				return
			}
			if r.Context().Err() != nil {
				h.log.DebugContext(r.Context(), "client went away", slog.String("upstream", string(name)))
				httpx.WriteError(w, httpx.NewError(http.StatusBadGateway, httpx.CodeUnavailable, "upstream service unavailable"))
				return
			}
			h.log.WarnContext(r.Context(), "upstream request failed", slog.String("upstream", string(name)), slog.Any("error", err))
			httpx.WriteError(w, httpx.NewError(http.StatusBadGateway, httpx.CodeUnavailable, "upstream service unavailable"))
		},
		ErrorLog: slog.NewLogLogger(h.log.Handler(), slog.LevelWarn),
	}
}

type limitedBody struct {
	io.ReadCloser
	exceeded atomic.Bool
}

func (l *limitedBody) Read(p []byte) (int, error) {
	n, err := l.ReadCloser.Read(p)
	var mbe *http.MaxBytesError
	if err != nil && errors.As(err, &mbe) {
		l.exceeded.Store(true)
	}
	return n, err
}

type recorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *recorder) WriteHeader(code int) {
	if r.status == 0 && code >= 200 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}

func (r *recorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *recorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (h *Handler) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		st := &state{}
		r = r.WithContext(context.WithValue(r.Context(), stateKey{}, st))
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		realIP := RealIP(r.Header)
		rec := &recorder{ResponseWriter: w}
		defer func() {
			status := rec.status
			if status == 0 {
				status = http.StatusOK
			}
			level := slog.LevelInfo
			if status >= 500 {
				level = slog.LevelError
			}
			path := r.URL.EscapedPath()
			if len(path) > maxLoggedPath {
				path = path[:maxLoggedPath]
			}
			h.log.LogAttrs(r.Context(), level, "http request",
				slog.String("method", r.Method),
				slog.String("path", path),
				slog.Int("status", status),
				slog.Int64("bytes", rec.bytes),
				slog.Duration("duration", time.Since(start)),
				slog.String("real_ip", realIP),
				slog.String("remote", r.RemoteAddr),
				slog.String("upstream", string(st.upstream)),
				slog.String("principal", st.principal),
			)
		}()
		next.ServeHTTP(rec, r)
	})
}

func RealIP(hdr http.Header) string {
	v := hdr.Get(RealIPHeader)
	if v == "" {
		return ""
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(v))
	if err != nil {
		return "invalid"
	}
	return addr.String()
}
