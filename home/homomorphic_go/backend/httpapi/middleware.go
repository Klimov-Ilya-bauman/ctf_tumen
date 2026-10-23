package httpapi

import (
	"context"
	"errors"
	"net/http"

	"homomorphicgo/auth"
	"homomorphicgo/store"
)

type ctxKey struct{}

func (a *API) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session")
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		hash, ok := auth.HashToken(c.Value)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		uid, err := a.Store.SessionUser(r.Context(), hash)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if err != nil {
			writeStoreErr(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, uid)))
	})
}

func userID(r *http.Request) int64 {
	uid, _ := r.Context().Value(ctxKey{}).(int64)
	return uid
}
