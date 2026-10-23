package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"homomorphicgo/auth"
	"homomorphicgo/store"
)

type sessionTestStore struct {
	StoreIface
	hash string
	err  error
}

type gameTestStore struct {
	*sessionTestStore
	game      *store.Game
	moveErr   error
	moveCalls int
	readCalls int
}

func (s *gameTestStore) GetGame(context.Context, int64) (*store.Game, error) { return s.game, nil }
func (s *gameTestStore) UserByID(_ context.Context, id int64) (*store.User, error) {
	return &store.User{ID: id, Username: "synthetic", Pubkey: bytes.Repeat([]byte{19}, 19)}, nil
}
func (s *gameTestStore) Moves(context.Context, int64, int64, int) ([]store.Move, error) {
	s.readCalls++
	return nil, nil
}
func (s *gameTestStore) Messages(context.Context, int64, int64, int) ([]store.Message, error) {
	s.readCalls++
	return nil, nil
}
func (s *gameTestStore) ApplyMove(_ context.Context, _ int64, uid, version int64, _ []byte) error {
	if uid != 7 {
		panic("wrong actor")
	}
	s.moveCalls++
	return s.moveErr
}

func gameTestAPI(t *testing.T, g *store.Game) (*API, *gameTestStore, string) {
	t.Helper()
	token, err := auth.NewTokens().Issue()
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := auth.HashToken(token)
	s := &gameTestStore{sessionTestStore: &sessionTestStore{hash: hash}, game: g}
	return &API{Store: s}, s, token
}

func TestPrivateGameReads(t *testing.T) {
	for _, path := range []string{"/api/games/1", "/api/games/1/moves", "/api/games/1/messages"} {
		t.Run(path, func(t *testing.T) {
			a, s, token := gameTestAPI(t, &store.Game{ID: 1, BlackID: 9})
			r := httptest.NewRequest("GET", path, nil)
			r.AddCookie(&http.Cookie{Name: "session", Value: token})
			w := httptest.NewRecorder()
			a.Routes().ServeHTTP(w, r)
			if w.Code != 403 || s.readCalls != 0 {
				t.Fatalf("status %d reads %d", w.Code, s.readCalls)
			}
		})
	}
}

func TestGameUsesSnapshotKey(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 19)
	a, _, token := gameTestAPI(t, &store.Game{ID: 1, BlackID: 7, BlackPubkey: key})
	r := httptest.NewRequest("GET", "/api/games/1", nil)
	r.AddCookie(&http.Cookie{Name: "session", Value: token})
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r)
	var response struct {
		Black struct {
			Key string `json:"pubkey_b64"`
		} `json:"black"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || response.Black.Key != base64.StdEncoding.EncodeToString(key) {
		t.Fatal("game leaked mutable account key")
	}
}

func TestMoveVersionCompatibility(t *testing.T) {
	white := int64(8)
	board := base64.StdEncoding.EncodeToString(make([]byte, 361))
	for _, tc := range []struct {
		field       string
		want, calls int
	}{
		{"", 200, 1}, {`,"version":null`, 200, 1}, {`,"version":-1`, 400, 0},
	} {
		a, s, token := gameTestAPI(t, &store.Game{ID: 1, BlackID: 7, WhiteID: &white, Status: "active"})
		r := httptest.NewRequest("POST", "/api/games/1/move", strings.NewReader(`{"board_c_b64":"`+board+`"`+tc.field+`}`))
		r.AddCookie(&http.Cookie{Name: "session", Value: token})
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		if w.Code != tc.want || s.moveCalls != tc.calls {
			t.Fatalf("status %d calls %d", w.Code, s.moveCalls)
		}
	}
}

func TestPaginationValidation(t *testing.T) {
	for _, query := range []string{"after=-1", "after=bad", "limit=0", "limit=101", "limit=99999999999999999999"} {
		a, s, token := gameTestAPI(t, &store.Game{ID: 1, BlackID: 7})
		r := httptest.NewRequest("GET", "/api/games/1/messages?"+query, nil)
		r.AddCookie(&http.Cookie{Name: "session", Value: token})
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		if w.Code != 400 || s.readCalls != 0 {
			t.Fatalf("query %s: %d", query, w.Code)
		}
	}
}

func TestCrossOriginWritesRejected(t *testing.T) {
	a := &API{}
	r := httptest.NewRequest("POST", "http://service.local/api/login", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://untrusted.invalid")
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("status %d", w.Code)
	}
}

func TestBrowserOriginOnPublishedPort(t *testing.T) {
	a := &API{}
	for _, tc := range []struct {
		name, host, origin string
		want               int
	}{
		{"published port preserved", "127.0.0.1:8081", "http://127.0.0.1:8081", 204},
		{"port stripped by proxy", "127.0.0.1", "http://127.0.0.1:8081", 403},
		{"different port", "127.0.0.1:8081", "http://127.0.0.1:8082", 403},
		{"untrusted host", "127.0.0.1:8081", "https://untrusted.invalid", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://"+tc.host+"/api/register", nil)
			r.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			a.cors(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
		})
	}
}

func (s *sessionTestStore) SessionUser(_ context.Context, hash string) (int64, error) {
	if hash != s.hash {
		return 0, store.ErrNotFound
	}
	return 7, s.err
}

func TestAuthRequiresStoredSession(t *testing.T) {
	token, err := auth.NewTokens().Issue()
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := auth.HashToken(token)
	for _, tc := range []struct {
		name, token string
		err         error
		want        int
	}{
		{"valid", token, nil, 204},
		{"expired or revoked", token, store.ErrNotFound, 401},
		{"database failure", token, errors.New("offline"), 500},
		{"forged legacy", "MTox", nil, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &API{Store: &sessionTestStore{hash: hash, err: tc.err}}
			r := httptest.NewRequest("GET", "/", nil)
			r.AddCookie(&http.Cookie{Name: "session", Value: tc.token})
			w := httptest.NewRecorder()
			a.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if userID(r) != 7 {
					t.Fatal("wrong identity")
				}
				w.WriteHeader(204)
			})).ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
		})
	}
}
