package httpapi

import (
	"context"
	"net/http"
)

type ctxKey struct{}

func (a *API) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session")
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		uid, ok := a.Tokens.Parse(c.Value)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, uid)))
	})
}

func userID(r *http.Request) int64 {
	uid, _ := r.Context().Value(ctxKey{}).(int64)
	return uid
}
