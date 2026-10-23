package httpapi

import (
	"encoding/base64"
	"errors"
	"net/http"

	"homomorphicgo/auth"
	"homomorphicgo/store"
)

const pubkeyLen = 19

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func validUsername(s string) bool {
	if len(s) < 1 || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

func validPassword(s string) bool {
	return len(s) >= 6 && len(s) <= 72
}

// decodePubkey returns (nil, true) for an empty value.
func decodePubkey(s string) ([]byte, bool) {
	if s == "" {
		return nil, true
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != pubkeyLen {
		return nil, false
	}
	return b, true
}

func b64(b []byte) string {
	if b == nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b)
}

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decodeJSON(w, r, &c) {
		return
	}
	if !validUsername(c.Username) || !validPassword(c.Password) {
		writeErr(w, http.StatusBadRequest, "invalid username or password")
		return
	}
	hash, err := auth.HashPassword(c.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	id, err := a.Store.CreateUser(r.Context(), c.Username, hash)
	if errors.Is(err, store.ErrDuplicate) {
		writeErr(w, http.StatusConflict, "username taken")
		return
	}
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int64{"user_id": id})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !decodeJSON(w, r, &c) {
		return
	}
	u, err := a.Store.UserByUsername(r.Context(), c.Username)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !auth.CheckPassword(u.PassHash, c.Password)) {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    a.Tokens.Issue(u.ID),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]int64{"user_id": u.ID})
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	u, err := a.Store.UserByID(r.Context(), userID(r))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": u.ID, "username": u.Username, "pubkey_b64": b64(u.Pubkey)})
}

type pubkeyReq struct {
	PubkeyB64 string `json:"pubkey_b64"`
}

func (a *API) keys(w http.ResponseWriter, r *http.Request) {
	var req pubkeyReq
	if !decodeJSON(w, r, &req) {
		return
	}
	pub, ok := decodePubkey(req.PubkeyB64)
	if !ok || pub == nil {
		writeErr(w, http.StatusBadRequest, "pubkey_b64 must decode to 19 bytes")
		return
	}
	if err := a.Store.SetPubkey(r.Context(), userID(r), pub); err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}
