package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"homomorphicgo/auth"
	"homomorphicgo/store"
)

type StoreIface interface {
	CreateSession(context.Context, string, int64, time.Time) error
	SessionUser(context.Context, string) (int64, error)
	DeleteSession(context.Context, string) error
	CreateUser(ctx context.Context, username, passHash string) (int64, error)
	UserByUsername(ctx context.Context, username string) (*store.User, error)
	UserByID(ctx context.Context, id int64) (*store.User, error)
	SetPubkey(ctx context.Context, userID int64, pub []byte) error
	CreateGame(ctx context.Context, blackID int64, pub []byte) (int64, error)
	JoinGame(ctx context.Context, gameID, whiteID int64, pub []byte) error
	GetGame(ctx context.Context, id int64) (*store.Game, error)
	ListGames(ctx context.Context, before int64, limit int) ([]store.Game, error)
	ApplyMove(ctx context.Context, gameID, userID, version int64, boardC []byte) error
	Moves(ctx context.Context, gameID, after int64, limit int) ([]store.Move, error)
	AddMessage(ctx context.Context, gameID, senderID int64, ct string) error
	Messages(ctx context.Context, gameID, after int64, limit int) ([]store.Message, error)
}

type API struct {
	Store         StoreIface
	Tokens        *auth.Tokens
	AllowOrigin   string
	SessionTTL    time.Duration
	SecureCookies bool
}

const maxBody = 64 << 10

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/register", a.register)
	mux.HandleFunc("POST /api/login", a.login)
	authed := func(pattern string, h http.HandlerFunc) {
		mux.Handle(pattern, a.requireAuth(h))
	}
	authed("GET /api/me", a.me)
	authed("POST /api/logout", a.logout)
	authed("POST /api/keys", a.keys)
	authed("GET /api/games", a.listGames)
	authed("POST /api/games", a.createGame)
	authed("GET /api/games/{id}", a.getGame)
	authed("POST /api/games/{id}/join", a.joinGame)
	authed("POST /api/games/{id}/move", a.move)
	authed("GET /api/games/{id}/moves", a.moves)
	authed("GET /api/games/{id}/messages", a.messages)
	authed("POST /api/games/{id}/messages", a.postMessage)
	return a.cors(mux)
}

func (a *API) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			origin := r.Header.Get("Origin")
			if origin != "" {
				u, err := url.Parse(origin)
				sameHost := err == nil && u.User == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https") && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
				if !sameHost && !a.originAllowed(origin) {
					writeErr(w, http.StatusForbidden, "origin not allowed")
					return
				}
			} else if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				writeErr(w, http.StatusForbidden, "cross-site request not allowed")
				return
			}
		}
		if origin := r.Header.Get("Origin"); origin != "" && a.originAllowed(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) originAllowed(origin string) bool {
	if a.AllowOrigin == "" {
		return false
	}
	for _, o := range strings.Split(a.AllowOrigin, ",") {
		if strings.TrimSpace(o) == origin {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrConflict), errors.Is(err, store.ErrDuplicate):
		writeErr(w, http.StatusConflict, "conflict")
	default:
		writeErr(w, http.StatusInternalServerError, "internal error")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed JSON")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeErr(w, http.StatusBadRequest, "body must contain one JSON value")
		return false
	}
	return true
}
