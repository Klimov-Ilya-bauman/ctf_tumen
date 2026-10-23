package health

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"sync"
	"time"

	"slopdns/web/pkg/httpx"
)

const (
	StatusOK          = "ok"
	StatusUnavailable = "unavailable"
	StatusError       = "error"
)

const DefaultTimeout = 2 * time.Second

type Checker func(ctx context.Context) error

type DetailsFunc func() any

type CheckResult struct {
	Status string `json:"status"`
}

type Response struct {
	Status  string                 `json:"status"`
	Checks  map[string]CheckResult `json:"checks,omitempty"`
	Details map[string]any         `json:"details,omitempty"`
}

type namedCheck struct {
	name  string
	check Checker
}

type Handler struct {
	mu      sync.RWMutex
	checks  []namedCheck
	details map[string]DetailsFunc
	timeout time.Duration
	logger  *slog.Logger
}

func New(logger *slog.Logger, timeout time.Duration) *Handler {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Handler{timeout: timeout, logger: logger, details: map[string]DetailsFunc{}}
}

func (h *Handler) Register(name string, check Checker) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, c := range h.checks {
		if c.name == name {
			h.checks[i].check = check
			return
		}
	}
	h.checks = append(h.checks, namedCheck{name: name, check: check})
}

func (h *Handler) RegisterDetails(name string, f DetailsFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.details[name] = f
}

func (h *Handler) Mount(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", h.Healthz)
	mux.HandleFunc("GET /readyz", h.Readyz)
	mux.Handle("/healthz", httpx.MethodNotAllowed(http.MethodGet, http.MethodHead))
	mux.Handle("/readyz", httpx.MethodNotAllowed(http.MethodGet, http.MethodHead))
}

func (h *Handler) Healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, Response{Status: StatusOK})
}

func (h *Handler) Readyz(w http.ResponseWriter, r *http.Request) {
	resp := h.Evaluate(r.Context())
	status := http.StatusOK
	if resp.Status != StatusOK {
		status = http.StatusServiceUnavailable
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, status, resp)
}

func (h *Handler) Evaluate(ctx context.Context) Response {
	h.mu.RLock()
	checks := append([]namedCheck(nil), h.checks...)
	details := make(map[string]DetailsFunc, len(h.details))
	for k, v := range h.details {
		details[k] = v
	}
	h.mu.RUnlock()

	ctx, cancel := context.WithTimeout(ctx, h.timeout)
	defer cancel()

	results := make([]error, len(checks))
	var wg sync.WaitGroup
	for i, c := range checks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = runCheck(ctx, c.check)
		}()
	}
	wg.Wait()

	resp := Response{Status: StatusOK}
	if len(checks) > 0 {
		resp.Checks = make(map[string]CheckResult, len(checks))
	}
	for i, c := range checks {
		if results[i] != nil {
			resp.Status = StatusUnavailable
			resp.Checks[c.name] = CheckResult{Status: StatusError}
			h.logger.WarnContext(ctx, "readiness check failed", slog.String("check", c.name), slog.Any("error", results[i]))
			continue
		}
		resp.Checks[c.name] = CheckResult{Status: StatusOK}
	}
	if len(details) > 0 {
		names := make([]string, 0, len(details))
		for k := range details {
			names = append(names, k)
		}
		sort.Strings(names)
		resp.Details = make(map[string]any, len(details))
		for _, k := range names {
			resp.Details[k] = details[k]()
		}
	}
	return resp
}

func runCheck(ctx context.Context, check Checker) error {
	done := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("check panicked: %v", r)
			}
		}()
		done <- check(ctx)
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func Probe(ctx context.Context, url string, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned HTTP %d", url, resp.StatusCode)
	}
	return nil
}

func LocalURL(listenAddr, path string) (string, error) {
	host, port, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return "", err
	}
	if port == "" {
		return "", errors.New("listen address has no port")
	}
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	return "http://" + net.JoinHostPort(host, port) + path, nil
}
