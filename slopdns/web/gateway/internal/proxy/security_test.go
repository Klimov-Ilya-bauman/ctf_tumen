package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"slopdns/web/gateway/internal/ratelimit"
)

func TestIPRejectedTrafficDoesNotSpendOtherClientsGlobalBudget(t *testing.T) {
	h, _, forwarded := gatewayForTest(1, 2, 10)
	if got := requestGateway(h, "/api/v1/auth/login", "192.0.2.1", ""); got != http.StatusNoContent {
		t.Fatal(got)
	}
	for range 10 {
		if got := requestGateway(h, "/api/v1/auth/login/totp", "192.0.2.1", ""); got != http.StatusTooManyRequests {
			t.Fatal(got)
		}
	}
	if got := requestGateway(h, "/api/v1/auth/login/totp", "192.0.2.2", ""); got != http.StatusNoContent {
		t.Fatalf("unrelated client denied: %d", got)
	}
	if *forwarded != 2 {
		t.Fatal(*forwarded)
	}
}

func TestPublicRequestThroughNewAndReverseProxy(t *testing.T) {
	forwarded := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded++
		if r.Header.Get("X-SlopDNS-Assertion") != "" {
			t.Error("untrusted assertion forwarded")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	in := &testIntrospector{}
	h, err := New(Config{IAMURL: target, BackendURL: target}, in, ratelimit.New(50, 100, nil), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/totp", nil)
	r.Header.Set("X-SlopDNS-Assertion", "forged")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("got %d", w.Code)
	}
	if forwarded != 1 || in.calls != 0 {
		t.Fatalf("forwarded=%d introspected=%d", forwarded, in.calls)
	}
}
