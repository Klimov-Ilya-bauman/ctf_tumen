package proxy

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"slopdns/web/gateway/internal/iamclient"
	"slopdns/web/gateway/internal/ratelimit"
)

type testIntrospector struct {
	calls    int
	inactive bool
}

func (i *testIntrospector) Introspect(context.Context, string) (iamclient.Identity, error) {
	i.calls++
	if i.inactive {
		return iamclient.Identity{}, iamclient.ErrInactive
	}
	return iamclient.Identity{ID: "same-principal"}, nil
}

func gatewayForTest(ipBurst, globalBurst, principalBurst int) (*Handler, *testIntrospector, *int) {
	now := time.Unix(1000, 0)
	clock := func() time.Time { return now }
	i := &testIntrospector{}
	forwarded := new(int)
	upstream := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { *forwarded++; w.WriteHeader(http.StatusNoContent) })
	return &Handler{cfg: Config{MaxBodyBytes: 1024}, introspector: i, limiter: ratelimit.New(1, principalBurst, clock),
		preAuthIP: ratelimit.New(1, ipBurst, clock), preAuthGlobal: ratelimit.New(1, globalBurst, clock),
		log: slog.New(slog.NewTextHandler(io.Discard, nil)), proxies: map[Upstream]http.Handler{UpstreamIAM: upstream, UpstreamBackend: upstream}}, i, forwarded
}
func requestGateway(h *Handler, path, ip, token string) int {
	r := httptest.NewRequest(http.MethodPost, path, nil)
	r.Header.Set(RealIPHeader, ip)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.serve(w, r)
	return w.Code
}

func TestPublicRequestsArePrelimited(t *testing.T) {
	h, i, forwarded := gatewayForTest(2, 10, 10)
	for range 2 {
		if got := requestGateway(h, "/api/v1/auth/login", "192.0.2.1", ""); got != http.StatusNoContent {
			t.Fatal(got)
		}
	}
	if got := requestGateway(h, "/api/v1/auth/register", "192.0.2.1", ""); got != http.StatusTooManyRequests {
		t.Fatalf("public request status %d", got)
	}
	if i.calls != 0 || *forwarded != 2 {
		t.Fatalf("introspection=%d forwarded=%d", i.calls, *forwarded)
	}
}
func TestInvalidTokensCannotBypassPreauthBudget(t *testing.T) {
	h, i, _ := gatewayForTest(2, 10, 10)
	i.inactive = true
	for range 2 {
		if got := requestGateway(h, "/api/v1/zones", "192.0.2.1", "sdpat_invalid"); got != http.StatusUnauthorized {
			t.Fatal(got)
		}
	}
	if got := requestGateway(h, "/api/v1/zones", "192.0.2.1", "sdpat_other"); got != http.StatusTooManyRequests {
		t.Fatal(got)
	}
	if i.calls != 2 {
		t.Fatalf("excess requests reached introspection: %d", i.calls)
	}
}
func TestGlobalBudgetBoundsRotatingIPs(t *testing.T) {
	h, i, _ := gatewayForTest(10, 2, 10)
	i.inactive = true
	requestGateway(h, "/api/v1/zones", "192.0.2.1", "sdpat_invalid")
	requestGateway(h, "/api/v1/auth/login", "192.0.2.2", "")
	if got := requestGateway(h, "/api/v1/zones", "192.0.2.3", "sdpat_invalid"); got != http.StatusTooManyRequests {
		t.Fatal(got)
	}
	if i.calls != 1 {
		t.Fatalf("global budget bypassed: %d", i.calls)
	}
}
func TestAuthenticatedPrincipalBudgetRemains(t *testing.T) {
	h, _, forwarded := gatewayForTest(10, 10, 1)
	if got := requestGateway(h, "/api/v1/zones", "192.0.2.1", "sdpat_one"); got != http.StatusNoContent {
		t.Fatal(got)
	}
	if got := requestGateway(h, "/api/v1/zones", "192.0.2.2", "sdpat_two"); got != http.StatusTooManyRequests {
		t.Fatal(got)
	}
	if *forwarded != 1 {
		t.Fatal("principal limit bypassed")
	}
}
func TestClientIPCanonicalAndFallback(t *testing.T) {
	for _, tt := range []struct {
		headers []string
		want    string
	}{
		{[]string{"2001:db8::1"}, "2001:db8::1"},
		{[]string{"::ffff:192.0.2.1"}, "192.0.2.1"},
		{[]string{"2001:0db8::1"}, "192.0.2.9"},
		{[]string{"192.0.2.1", "192.0.2.2"}, "192.0.2.9"},
		{[]string{"invalid"}, "192.0.2.9"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = "192.0.2.9:1234"
		for _, value := range tt.headers {
			r.Header.Add(RealIPHeader, value)
		}
		if got := clientIP(r); got != tt.want {
			t.Fatalf("%v: got %q want %q", tt.headers, got, tt.want)
		}
	}
}
