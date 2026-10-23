package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/core"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/httpx"
	"slopdns/web/pkg/rbac"
)

const (
	Prefix       = "/api/v1"
	CookieName   = "slopdns_session"
	MaxBodyBytes = 64 << 10
	defaultLimit = core.DefaultPageSize
)

type Config struct {
	CookieSecure bool
}

type API struct {
	svc      *core.Service
	verifier *assertion.Verifier
	log      *slog.Logger
	cfg      Config
}

func New(svc *core.Service, verifier *assertion.Verifier, logger *slog.Logger, cfg Config) *API {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &API{svc: svc, verifier: verifier, log: logger, cfg: cfg}
}

type handlerFunc func(w http.ResponseWriter, r *http.Request) error

type authedFunc func(w http.ResponseWriter, r *http.Request, c core.Caller) error

type route map[string]http.Handler

func (rt route) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h, ok := rt[r.Method]; ok {
		h.ServeHTTP(w, r)
		return
	}
	allowed := make([]string, 0, len(rt))
	for m := range rt {
		allowed = append(allowed, m)
	}
	sort.Strings(allowed)
	httpx.MethodNotAllowed(allowed...).ServeHTTP(w, r)
}

func (a *API) Mount(mux *http.ServeMux) {
	p := Prefix
	mux.Handle(p+"/auth/register", route{http.MethodPost: a.public(a.register)})
	mux.Handle(p+"/auth/login", route{http.MethodPost: a.public(a.login)})
	mux.Handle(p+"/auth/login/totp", route{http.MethodPost: a.public(a.loginTOTP)})
	mux.Handle(p+"/auth/logout", route{http.MethodPost: a.authed(a.logout)})
	mux.Handle(p+"/auth/me", route{http.MethodGet: a.authed(a.me)})
	mux.Handle(p+"/auth/totp/setup", route{http.MethodPost: a.authed(a.totpSetup)})
	mux.Handle(p+"/auth/totp/enable", route{http.MethodPost: a.authed(a.totpEnable)})
	mux.Handle(p+"/auth/totp/disable", route{http.MethodPost: a.authed(a.totpDisable)})
	mux.Handle(p+"/auth/totp/recovery-codes", route{http.MethodPost: a.authed(a.recoveryCodes)})
	mux.Handle(p+"/users/me/tokens", route{http.MethodGet: a.authed(a.listMyTokens), http.MethodPost: a.authed(a.createMyToken)})
	mux.Handle(p+"/users/me/tokens/{token_id}", route{http.MethodDelete: a.authed(a.revokeMyToken)})
	mux.Handle(p+"/service-accounts", route{http.MethodGet: a.authed(a.listServiceAccounts), http.MethodPost: a.authed(a.createServiceAccount)})
	mux.Handle(p+"/service-accounts/{service_account_id}", route{http.MethodGet: a.authed(a.getServiceAccount), http.MethodPatch: a.authed(a.updateServiceAccount), http.MethodDelete: a.authed(a.deleteServiceAccount)})
	mux.Handle(p+"/service-accounts/{service_account_id}/tokens", route{http.MethodGet: a.authed(a.listSATokens), http.MethodPost: a.authed(a.createSAToken)})
	mux.Handle(p+"/service-accounts/{service_account_id}/tokens/{token_id}", route{http.MethodDelete: a.authed(a.revokeSAToken)})
	mux.Handle(p+"/role-bindings", route{http.MethodGet: a.authed(a.listRoleBindings), http.MethodPost: a.authed(a.createRoleBinding)})
	mux.Handle(p+"/role-bindings/{binding_id}", route{http.MethodPatch: a.authed(a.updateRoleBinding), http.MethodDelete: a.authed(a.deleteRoleBinding)})
}

func (a *API) report(w http.ResponseWriter, r *http.Request, err error) {
	httpx.ReportError(a.log, w, r, toHTTP(err))
}

func (a *API) public(h handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := h(w, r); err != nil {
			a.report(w, r, err)
		}
	})
}

func (a *API) authed(h authedFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		sub, err := assertion.FromRequest(a.verifier, r)
		if err != nil {
			httpx.WriteError(w, httpx.Unauthenticated("authentication required"))
			return
		}
		c, err := a.caller(r, sub)
		if err != nil {
			httpx.WriteError(w, httpx.Unauthenticated("authentication required"))
			return
		}
		if err := h(w, r, c); err != nil {
			a.report(w, r, err)
		}
	})
}

func (a *API) caller(r *http.Request, sub assertion.Subject) (core.Caller, error) {
	id, err := uuid.Parse(sub.ID)
	if err != nil {
		return core.Caller{}, err
	}
	c := core.Caller{Type: rbac.PrincipalType(sub.Type), ID: id}
	if sub.Type == assertion.PrincipalServiceAccount {
		if c.OrgID, err = uuid.Parse(sub.OrgID); err != nil {
			return core.Caller{}, err
		}
		return c, nil
	}
	if r.Header.Get("Authorization") != "" {
		return c, nil
	}
	if cookie, cerr := r.Cookie(CookieName); cerr == nil {
		if sid, ok := a.svc.SessionFor(r.Context(), cookie.Value, id); ok {
			c.SessionID = &sid
		}
	}
	return c, nil
}

func toHTTP(err error) error {
	var ce *core.Error
	if !errors.As(err, &ce) {
		var he *httpx.Error
		if errors.As(err, &he) {
			return err
		}
		return httpx.Internal().WithCause(err)
	}
	msg := ce.Message
	switch ce.Kind {
	case core.KindInvalid:
		return httpx.Validation(ce.Field, msg)
	case core.KindUnauthenticated:
		return httpx.Unauthenticated(msg)
	case core.KindInvalidCredentials:
		return httpx.NewError(http.StatusUnauthorized, httpx.CodeInvalidCredentials, msg)
	case core.KindMFAInvalid:
		return httpx.NewError(http.StatusUnauthorized, httpx.CodeMFAInvalid, msg)
	case core.KindForbidden:
		return httpx.Forbidden(msg)
	case core.KindNotFound:
		return httpx.NotFound(msg)
	case core.KindConflict, core.KindFailedPrecondition:
		return httpx.Conflict(msg)
	case core.KindRateLimited:
		secs := int(ce.RetryAfter / time.Second)
		return httpx.RateLimited(secs)
	case core.KindUnavailable:
		return httpx.Unavailable(msg).WithCause(err)
	}
	return httpx.Internal().WithCause(err)
}

func decode(w http.ResponseWriter, r *http.Request, dst any) error {
	return httpx.DecodeJSON(w, r, dst, MaxBodyBytes)
}

func pathID(r *http.Request, name string) (uuid.UUID, error) {
	return core.ParseID(name, r.PathValue(name))
}

func queryValue(r *http.Request, name string) (*string, error) {
	vs, ok := r.URL.Query()[name]
	if !ok {
		return nil, nil
	}
	if len(vs) != 1 {
		return nil, httpx.Validation(name, "must be given at most once")
	}
	return &vs[0], nil
}

func queryInt(r *http.Request, name string, def int) (int, error) {
	v, err := queryValue(r, name)
	if err != nil || v == nil {
		return def, err
	}
	if *v == "" || strings.TrimSpace(*v) != *v || len(*v) > 9 {
		return 0, httpx.Validation(name, "must be an integer")
	}
	n, err := strconv.Atoi(*v)
	if err != nil {
		return 0, httpx.Validation(name, "must be an integer")
	}
	return n, nil
}

func page(r *http.Request) (core.Page, error) {
	limit, err := queryInt(r, "limit", defaultLimit)
	if err != nil {
		return core.Page{}, err
	}
	offset, err := queryInt(r, "offset", 0)
	if err != nil {
		return core.Page{}, err
	}
	return core.CheckPage(limit, offset)
}

type pageBody[T any] struct {
	Items  []T `json:"items"`
	Total  int `json:"total"`
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

func newPage[T any](items []T, total int, p core.Page) pageBody[T] {
	if items == nil {
		items = []T{}
	}
	return pageBody[T]{Items: items, Total: total, Limit: p.Limit, Offset: p.Offset}
}

func (a *API) sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: CookieName, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteStrictMode}
}
