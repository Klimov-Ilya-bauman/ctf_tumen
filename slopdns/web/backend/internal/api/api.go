package api

import (
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/core"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/httpx"
)

const (
	Prefix          = "/api/v1"
	DefaultLimit    = 100
	MaxLimit        = 500
	MaxOffset       = 1000000
	maxBodyBytes    = 1 << 20
	maxZoneNameFlt  = 254
	maxRecordTypeLn = 10
)

type Handler struct {
	svc    *core.Service
	logger *slog.Logger
}

func New(svc *core.Service, logger *slog.Logger) *Handler {
	return &Handler{svc: svc, logger: logger}
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, p authz.Principal) error

func principal(s assertion.Subject) authz.Principal {
	t := iamv1.PrincipalType_PRINCIPAL_TYPE_USER
	if s.Type == assertion.PrincipalServiceAccount {
		t = iamv1.PrincipalType_PRINCIPAL_TYPE_SERVICE_ACCOUNT
	}
	return authz.Principal{Type: t, ID: s.ID, Version: s.AuthzVersion}
}

func (h *Handler) wrap(fn handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, ok := assertion.FromContext(r.Context())
		if !ok {
			httpx.WriteError(w, httpx.Unauthenticated("authentication required"))
			return
		}
		if err := fn(w, r, principal(s)); err != nil {
			httpx.ReportError(h.logger, w, r, err)
		}
	})
}

func (h *Handler) Mount(mux *http.ServeMux, verifier *assertion.Verifier) {
	auth := assertion.Require(verifier)
	methods := map[string][]string{}
	var paths []string
	route := func(pattern string, fn handlerFunc) {
		method, path, _ := strings.Cut(pattern, " ")
		if _, seen := methods[path]; !seen {
			paths = append(paths, path)
		}
		methods[path] = append(methods[path], method)
		mux.Handle(method+" "+Prefix+path, httpx.Chain(h.wrap(fn), auth, httpx.BodyLimit(maxBodyBytes)))
	}
	defer func() {
		for _, path := range paths {
			allowed := methods[path]
			if slices.Contains(allowed, http.MethodGet) {
				allowed = append(allowed, http.MethodHead)
			}
			mux.Handle(Prefix+path, httpx.MethodNotAllowed(allowed...))
		}
	}()
	route("GET /orgs", h.listOrgs)
	route("POST /orgs", h.createOrg)
	route("GET /orgs/{org_id}", h.getOrg)
	route("PATCH /orgs/{org_id}", h.updateOrg)
	route("DELETE /orgs/{org_id}", h.deleteOrg)
	route("GET /orgs/{org_id}/members", h.listMembers)
	route("DELETE /orgs/{org_id}/members/{user_id}", h.removeMember)
	route("POST /orgs/{org_id}/transfer-ownership", h.transferOwnership)
	route("GET /orgs/{org_id}/invitations", h.listOrgInvitations)
	route("POST /orgs/{org_id}/invitations", h.createInvitation)
	route("GET /invitations", h.listMyInvitations)
	route("POST /invitations/{invitation_id}/accept", h.acceptInvitation)
	route("POST /invitations/{invitation_id}/decline", h.declineInvitation)
	route("POST /invitations/{invitation_id}/revoke", h.revokeInvitation)
	route("GET /zones", h.listZones)
	route("POST /zones", h.createZone)
	route("GET /zones/{zone_id}", h.getZone)
	route("PATCH /zones/{zone_id}", h.updateZone)
	route("DELETE /zones/{zone_id}", h.deleteZone)
	route("POST /zones/{zone_id}/transfer", h.createTransfer)
	route("GET /zones/{zone_id}/records", h.listRecords)
	route("POST /zones/{zone_id}/records", h.createRecord)
	route("GET /records/{record_id}", h.getRecord)
	route("PUT /records/{record_id}", h.replaceRecord)
	route("DELETE /records/{record_id}", h.deleteRecord)
	route("GET /zone-transfers", h.listTransfers)
	route("GET /zone-transfers/{transfer_id}", h.getTransfer)
	route("POST /zone-transfers/{transfer_id}/accept", h.acceptTransfer)
	route("POST /zone-transfers/{transfer_id}/decline", h.declineTransfer)
	route("POST /zone-transfers/{transfer_id}/cancel", h.cancelTransfer)
	mux.Handle(Prefix+"/", httpx.NotFoundHandler())
}

func pathID(r *http.Request, name string) (string, error) {
	v := r.PathValue(name)
	if !core.ValidUUID(v) {
		return "", httpx.Validation(name, "must be a lower-case UUID")
	}
	return v, nil
}

func queryValue(q url.Values, name string) (string, bool, error) {
	vs, ok := q[name]
	if !ok {
		return "", false, nil
	}
	if len(vs) != 1 {
		return "", false, httpx.Validation(name, "must be given at most once")
	}
	return vs[0], true, nil
}

func queryInt(q url.Values, name string, def, lo, hi int) (int, error) {
	v, ok, err := queryValue(q, name)
	if err != nil || !ok {
		return def, err
	}
	if v == "" || (len(v) > 1 && v[0] == '0') || strings.HasPrefix(v, "+") {
		return 0, httpx.Validation(name, "must be an integer between "+strconv.Itoa(lo)+" and "+strconv.Itoa(hi))
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		return 0, httpx.Validation(name, "must be an integer between "+strconv.Itoa(lo)+" and "+strconv.Itoa(hi))
	}
	return n, nil
}

func pageReq(r *http.Request) (core.PageReq, error) {
	q := r.URL.Query()
	limit, err := queryInt(q, "limit", DefaultLimit, 1, MaxLimit)
	if err != nil {
		return core.PageReq{}, err
	}
	offset, err := queryInt(q, "offset", 0, 0, MaxOffset)
	if err != nil {
		return core.PageReq{}, err
	}
	return core.PageReq{Limit: limit, Offset: offset}, nil
}

func queryEnum(r *http.Request, name string, valid func(string) bool) (string, error) {
	v, ok, err := queryValue(r.URL.Query(), name)
	if err != nil || !ok {
		return "", err
	}
	if v == "" || !valid(v) {
		return "", httpx.Validation(name, "has an unsupported value")
	}
	return v, nil
}

func decode(w http.ResponseWriter, r *http.Request, dst any) error {
	return httpx.DecodeJSON(w, r, dst, maxBodyBytes)
}

func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, status, v)
	return nil
}

func noContent(w http.ResponseWriter) error {
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func requiredString(p *string, field string) (string, error) {
	if p == nil {
		return "", httpx.Validation(field, "is required")
	}
	return *p, nil
}
