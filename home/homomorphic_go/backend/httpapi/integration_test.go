package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"homomorphicgo/auth"
	"homomorphicgo/store"
)

func TestHTTPDatabaseLifecycle(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required for HTTP/database integration")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [12]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	schema := "api_test_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	}()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := &store.Store{Pool: pool}
	defer s.Close()
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	a := &API{Store: s, Tokens: auth.NewTokens(), SessionTTL: time.Hour, SecureCookies: true}
	handler := a.Routes()
	request := func(method, path string, body any, cookie *http.Cookie, want int) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s: status %d want %d", method, path, w.Code, want)
		}
		return w
	}
	login := func(name string) *http.Cookie {
		t.Helper()
		credentials := map[string]string{"username": name, "password": "synthetic-test-password"}
		request("POST", "/api/register", credentials, nil, 201)
		w := request("POST", "/api/login", credentials, nil, 200)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].MaxAge != 3600 {
			t.Fatal("unsafe session cookie")
		}
		return cookies[0]
	}
	black := login("black")
	white := login("white")
	outsider := login("outsider")
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 19))
	response := request("POST", "/api/games", map[string]string{"pubkey_b64": key}, black, 201)
	var created struct {
		ID int64 `json:"game_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil || created.ID != 1 {
		t.Fatalf("created game: %v", err)
	}
	request("GET", "/api/games/1", nil, outsider, 403)
	request("GET", "/api/games/1/messages", nil, outsider, 403)
	request("GET", "/api/games/1/moves", nil, outsider, 403)
	request("POST", "/api/games/1/join", map[string]string{"pubkey_b64": key}, black, 409)
	request("POST", "/api/games/1/join", map[string]string{"pubkey_b64": key}, white, 200)
	request("POST", "/api/keys", map[string]string{"pubkey_b64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{11}, 19))}, black, 200)
	g, err := s.GetGame(ctx, 1)
	if err != nil || base64.StdEncoding.EncodeToString(g.BlackPubkey) != key {
		t.Fatal("account key changed game")
	}
	board := base64.StdEncoding.EncodeToString(make([]byte, 361))
	request("POST", "/api/games/1/move", map[string]any{"board_c_b64": board}, black, 400)
	request("POST", "/api/games/1/move", map[string]any{"board_c_b64": board, "version": g.Version}, outsider, 403)
	request("POST", "/api/games/1/move", map[string]any{"board_c_b64": board, "version": g.Version}, white, 409)
	request("POST", "/api/games/1/move", map[string]any{"board_c_b64": board, "version": g.Version}, black, 200)
	request("POST", "/api/games/1/move", map[string]any{"board_c_b64": board, "version": g.Version}, white, 409)
	request("POST", "/api/games/1/messages", map[string]string{"ciphertext": "synthetic-test-ciphertext"}, black, 201)
	request("GET", "/api/games/1/messages?limit=1", nil, white, 200)
	request("POST", "/api/logout", nil, black, 200)
	request("GET", "/api/me", nil, black, 401)
}
