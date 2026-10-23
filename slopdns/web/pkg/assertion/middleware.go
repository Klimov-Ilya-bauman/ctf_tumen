package assertion

import (
	"context"
	"net/http"

	"slopdns/web/pkg/httpx"
)

type ctxKey struct{}

func WithSubject(ctx context.Context, s Subject) context.Context {
	return context.WithValue(ctx, ctxKey{}, s)
}

func FromContext(ctx context.Context) (Subject, bool) {
	s, ok := ctx.Value(ctxKey{}).(Subject)
	return s, ok
}

func FromRequest(v *Verifier, r *http.Request) (Subject, error) {
	values := r.Header.Values(Header)
	if len(values) == 0 {
		return Subject{}, ErrMissing
	}
	if len(values) > 1 {
		return Subject{}, ErrMalformed
	}
	return v.Verify(values[0])
}

func Require(v *Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			s, err := FromRequest(v, r)
			if err != nil {
				httpx.WriteError(w, httpx.Unauthenticated("authentication required").WithCause(err))
				return
			}
			next.ServeHTTP(w, r.WithContext(WithSubject(r.Context(), s)))
		})
	}
}

func Optional(v *Verifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if len(r.Header.Values(Header)) == 0 {
				next.ServeHTTP(w, r)
				return
			}
			s, err := FromRequest(v, r)
			if err != nil {
				httpx.WriteError(w, httpx.Unauthenticated("authentication required").WithCause(err))
				return
			}
			next.ServeHTTP(w, r.WithContext(WithSubject(r.Context(), s)))
		})
	}
}
