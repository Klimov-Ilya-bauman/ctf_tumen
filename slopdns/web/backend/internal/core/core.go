package core

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/lru"
	"slopdns/web/backend/internal/outbox"
	"slopdns/web/backend/internal/store"
	"slopdns/web/pkg/httpx"
)

const (
	InvitationTTL = 7 * 24 * time.Hour
	TransferTTL   = 7 * 24 * time.Hour
	MaxTTL        = 2147483647
)

type ZoneDefaults struct {
	Suffix      string
	DefaultTTL  int32
	MName       string
	RName       string
	Refresh     int32
	Retry       int32
	Expire      int32
	Minimum     int32
	NameServers []string
	Reserved    []string
}

type Service struct {
	store    *store.Store
	iam      iamv1.IamServiceClient
	authz    authz.Authorizer
	dispatch *outbox.Dispatcher
	logger   *slog.Logger
	defaults ZoneDefaults
	now      func() time.Time
	names    *lru.Cache[string, string]
	ids      *lru.Cache[string, string]
	limits   Limits
	reserved []string
}

const (
	DefaultUserCacheSize = 10000
	DefaultUserCacheTTL  = 10 * time.Minute
)

func New(st *store.Store, iam iamv1.IamServiceClient, az authz.Authorizer, d *outbox.Dispatcher, logger *slog.Logger, defaults ZoneDefaults) *Service {
	return &Service{
		store: st, iam: iam, authz: az, dispatch: d, logger: logger, defaults: defaults, now: time.Now,
		names:  lru.New[string, string](DefaultUserCacheSize, DefaultUserCacheTTL),
		ids:    lru.New[string, string](DefaultUserCacheSize, DefaultUserCacheTTL),
		limits: DefaultLimits(), reserved: ReservedNames(defaults),
	}
}

func (s *Service) SetUserCache(size int, ttl time.Duration) {
	s.names = lru.New[string, string](size, ttl)
	s.ids = lru.New[string, string](size, ttl)
}

func (s *Service) rememberUser(id, name string) {
	s.names.Put(id, name)
	s.ids.Put(name, id)
}

func (s *Service) SetClock(now func() time.Time) {
	s.now = now
}

func (s *Service) Defaults() ZoneDefaults {
	return s.defaults
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func ValidUUID(s string) bool {
	return uuidRe.MatchString(s)
}

func newID() string {
	return uuid.Must(uuid.NewV7()).String()
}

func notFound(what string) error {
	return httpx.NotFound(what + " not found")
}

func forbidden(msg string) error {
	return httpx.Forbidden(msg)
}

func conflict(msg string) error {
	return httpx.Conflict(msg)
}

func invalid(field, msg string) error {
	return httpx.Validation(field, msg)
}

func iamError(err error) error {
	if err == nil {
		return nil
	}
	var he *httpx.Error
	if errors.As(err, &he) {
		return err
	}
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded, codes.Canceled, codes.ResourceExhausted:
		return httpx.Unavailable("IAM is unavailable").WithCause(err)
	}
	return httpx.Internal().WithCause(err)
}

func dbError(err error) error {
	if err == nil {
		return nil
	}
	var he *httpx.Error
	if errors.As(err, &he) {
		return err
	}
	return httpx.NewError(http.StatusInternalServerError, httpx.CodeInternal, "internal error").WithCause(err)
}

func (s *Service) bindings(ctx context.Context, p authz.Principal) ([]authz.Binding, error) {
	bs, err := s.authz.Bindings(ctx, p)
	if err != nil {
		return nil, iamError(err)
	}
	return bs, nil
}

func (s *Service) validZoneRoles(ctx context.Context, bs []authz.Binding) (map[string]authz.Binding, error) {
	zb := authz.ZoneBindings(bs)
	if len(zb) == 0 {
		return map[string]authz.Binding{}, nil
	}
	ids := make([]string, 0, len(zb))
	for _, b := range zb {
		ids = append(ids, b.ResourceID)
	}
	orgs, err := s.store.Q().ZoneOrgs(ctx, ids)
	if err != nil {
		return nil, dbError(err)
	}
	out := map[string]authz.Binding{}
	for _, b := range zb {
		if orgs[b.ResourceID] == b.OrgID && b.Role != authz.RoleOwner {
			if cur, ok := out[b.ResourceID]; !ok || b.Role > cur.Role {
				out[b.ResourceID] = b
			}
		}
	}
	return out, nil
}

func (s *Service) memberOrgs(ctx context.Context, bs []authz.Binding) (map[string]bool, error) {
	out := map[string]bool{}
	for _, b := range authz.OrgBindings(bs) {
		out[b.OrgID] = true
	}
	for _, org := range authz.ServiceAccountOrgs(bs) {
		out[org] = true
	}
	zones, err := s.validZoneRoles(ctx, bs)
	if err != nil {
		return nil, err
	}
	for _, b := range zones {
		out[b.OrgID] = true
	}
	return out, nil
}

func (s *Service) requireOrg(ctx context.Context, p authz.Principal, orgID string, action authz.Action) (store.Org, authz.Role, []authz.Binding, error) {
	org, err := s.store.Q().GetOrg(ctx, orgID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Org{}, authz.RoleNone, nil, notFound("organization")
	}
	if err != nil {
		return store.Org{}, authz.RoleNone, nil, dbError(err)
	}
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return store.Org{}, authz.RoleNone, nil, err
	}
	role := authz.OrgRole(bs, org.ID)
	if authz.AllowedOrg(role, action) {
		return org, role, bs, nil
	}
	members, err := s.memberOrgs(ctx, bs)
	if err != nil {
		return store.Org{}, authz.RoleNone, nil, err
	}
	if !members[org.ID] {
		return store.Org{}, authz.RoleNone, nil, notFound("organization")
	}
	return store.Org{}, role, bs, forbidden("insufficient role on the organization")
}

func zoneAccess(bs []authz.Binding, z store.Zone, action authz.Action) (authz.Role, error) {
	role := authz.ZoneRole(bs, z.ID, z.OrgID)
	if role == authz.RoleNone {
		return role, notFound("zone")
	}
	if !authz.AllowedZone(role, action) {
		return role, forbidden("insufficient role on the zone")
	}
	return role, nil
}

func (s *Service) requireZone(ctx context.Context, p authz.Principal, zoneID string, action authz.Action) (store.Zone, authz.Role, []authz.Binding, error) {
	z, err := s.store.Q().GetZone(ctx, zoneID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Zone{}, authz.RoleNone, nil, notFound("zone")
	}
	if err != nil {
		return store.Zone{}, authz.RoleNone, nil, dbError(err)
	}
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return store.Zone{}, authz.RoleNone, nil, err
	}
	role, err := zoneAccess(bs, z, action)
	if err != nil {
		return store.Zone{}, role, nil, err
	}
	return z, role, bs, nil
}

func (s *Service) lookupUsers(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	var missing []string
	for _, id := range ids {
		if id == "" {
			continue
		}
		if _, done := out[id]; done {
			continue
		}
		if name, ok := s.names.Get(id); ok {
			out[id] = name
			continue
		}
		out[id] = ""
		missing = append(missing, id)
	}
	if len(missing) > 0 {
		resp, err := s.iam.LookupUsers(ctx, &iamv1.LookupUsersRequest{UserIds: missing})
		if err != nil {
			return nil, iamError(err)
		}
		for _, u := range resp.GetUsers() {
			s.rememberUser(u.GetId(), u.GetUsername())
			out[u.GetId()] = u.GetUsername()
		}
	}
	for id, name := range out {
		if name == "" {
			delete(out, id)
		}
	}
	return out, nil
}

func (s *Service) userByName(ctx context.Context, username string) (string, bool, error) {
	if id, ok := s.ids.Get(username); ok {
		return id, true, nil
	}
	resp, err := s.iam.LookupUsers(ctx, &iamv1.LookupUsersRequest{Usernames: []string{username}})
	if err != nil {
		return "", false, iamError(err)
	}
	for _, u := range resp.GetUsers() {
		if u.GetUsername() == username {
			s.rememberUser(u.GetId(), u.GetUsername())
			return u.GetId(), true, nil
		}
	}
	return "", false, nil
}

func (s *Service) afterCommit(ctx context.Context, ids []string) {
	if s.dispatch == nil || len(ids) == 0 {
		return
	}
	s.dispatch.DispatchIDs(context.WithoutCancel(ctx), ids)
}

func (s *Service) Expire(ctx context.Context) error {
	q := s.store.Q()
	now := s.now()
	if _, err := q.ExpireInvitations(ctx, now); err != nil {
		return err
	}
	_, err := q.ExpireTransfers(ctx, now)
	return err
}

func (s *Service) expireLazily(ctx context.Context) error {
	return dbError(s.Expire(ctx))
}

var usernameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,31}$`)

func ValidUsername(s string) bool {
	return usernameRe.MatchString(s)
}

var orgNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,62}$`)

func ValidOrgName(s string) bool {
	return orgNameRe.MatchString(s)
}

func requireUser(p authz.Principal, msg string) error {
	if !p.IsUser() {
		return forbidden(msg)
	}
	return nil
}

func isForbidden(err error) bool {
	var he *httpx.Error
	return errors.As(err, &he) && he.Status == http.StatusForbidden
}
