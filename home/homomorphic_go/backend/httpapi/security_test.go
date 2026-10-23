package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"homomorphicgo/auth"
	"homomorphicgo/store"
)

type sessionTestStore struct {
	StoreIface
	hash string
	err error
}

func (s *sessionTestStore) SessionUser(_ context.Context, hash string) (int64, error) {
	if hash != s.hash { return 0, store.ErrNotFound }
	return 7, s.err
}

func TestAuthRequiresStoredSession(t *testing.T) {
	token, err := auth.NewTokens().Issue()
	if err != nil { t.Fatal(err) }
	hash, _ := auth.HashToken(token)
	for _, tc := range []struct { name, token string; err error; want int }{
		{"valid", token, nil, 204},
		{"expired or revoked", token, store.ErrNotFound, 401},
		{"database failure", token, errors.New("offline"), 500},
		{"forged legacy", "MTox", nil, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &API{Store:&sessionTestStore{hash:hash, err:tc.err}}
			r := httptest.NewRequest("GET", "/", nil)
			r.AddCookie(&http.Cookie{Name:"session", Value:tc.token})
			w := httptest.NewRecorder()
			a.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if userID(r) != 7 { t.Fatal("wrong identity") }
				w.WriteHeader(204)
			})).ServeHTTP(w,r)
			if w.Code != tc.want { t.Fatalf("status %d, want %d",w.Code,tc.want) }
		})
	}
}
