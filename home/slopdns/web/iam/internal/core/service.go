package core

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/password"
	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/totp"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/rbac"
)

var (
	ErrBackendNotFound    = errors.New("backend: resource not found")
	ErrBackendUnavailable = errors.New("backend: unavailable")
)

type Backend interface {
	EnsureDefaultOrg(ctx context.Context, userID uuid.UUID, username string) error
	ResourceOrg(ctx context.Context, rt rbac.ResourceType, id uuid.UUID) (uuid.UUID, error)
}

type Config struct {
	SessionTTL       time.Duration
	SessionAbsolute  time.Duration
	MFATTL           time.Duration
	TouchInterval    time.Duration
	DefaultTokenDays int
	TOTPIssuer       string
	BackendTimeout   time.Duration
}

func DefaultConfig() Config {
	return Config{
		SessionTTL:       12 * time.Hour,
		SessionAbsolute:  7 * 24 * time.Hour,
		MFATTL:           5 * time.Minute,
		TouchInterval:    60 * time.Second,
		DefaultTokenDays: 90,
		TOTPIssuer:       "SlopDNS",
		BackendTimeout:   3 * time.Second,
	}
}

type Deps struct {
	Store   store.Store
	Hasher  *password.Hasher
	Cipher  *totp.Cipher
	Issuer  *assertion.Issuer
	Backend Backend
	Logger  *slog.Logger
	Now     func() time.Time
	Config  Config
}

type Service struct {
	store   store.Store
	hasher  *password.Hasher
	cipher  *totp.Cipher
	issuer  *assertion.Issuer
	backend Backend
	log     *slog.Logger
	now     func() time.Time
	cfg     Config
}

func New(d Deps) (*Service, error) {
	if d.Store == nil || d.Hasher == nil || d.Cipher == nil || d.Issuer == nil || d.Backend == nil {
		return nil, errors.New("core: missing dependency")
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logger == nil {
		d.Logger = slog.New(slog.DiscardHandler)
	}
	def := DefaultConfig()
	c := d.Config
	if c.SessionTTL <= 0 {
		c.SessionTTL = def.SessionTTL
	}
	if c.SessionAbsolute <= 0 {
		c.SessionAbsolute = def.SessionAbsolute
	}
	if c.MFATTL <= 0 {
		c.MFATTL = def.MFATTL
	}
	if c.TouchInterval <= 0 {
		c.TouchInterval = def.TouchInterval
	}
	if c.DefaultTokenDays <= 0 {
		c.DefaultTokenDays = def.DefaultTokenDays
	}
	if c.TOTPIssuer == "" {
		c.TOTPIssuer = def.TOTPIssuer
	}
	if c.BackendTimeout <= 0 {
		c.BackendTimeout = def.BackendTimeout
	}
	return &Service{store: d.Store, hasher: d.Hasher, cipher: d.Cipher, issuer: d.Issuer, backend: d.Backend, log: d.Logger, now: d.Now, cfg: c}, nil
}

func (s *Service) clock() time.Time {
	return s.now().UTC().Truncate(time.Microsecond)
}

type Caller struct {
	Type      rbac.PrincipalType
	ID        uuid.UUID
	OrgID     uuid.UUID
	SessionID *uuid.UUID
}

func (c Caller) Principal() store.Principal {
	return store.Principal{Type: c.Type, ID: c.ID}
}

func (c Caller) IsUser() bool {
	return c.Type == rbac.PrincipalUser
}

func (s *Service) inTx(ctx context.Context, fn func(store.Tx) error) error {
	err := s.store.InTx(ctx, fn)
	if err == nil {
		return nil
	}
	var ce *Error
	if errors.As(err, &ce) {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return unavailable("request cancelled", err)
	}
	return internal(err)
}

func (s *Service) hashErr(err error) error {
	if errors.Is(err, password.ErrBusy) {
		return busy()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return unavailable("request cancelled", err)
	}
	return internal(err)
}

func (s *Service) backendCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), s.cfg.BackendTimeout)
}

func (s *Service) ensureDefaultOrg(ctx context.Context, u store.User) {
	bctx, cancel := s.backendCtx(ctx)
	defer cancel()
	if err := s.backend.EnsureDefaultOrg(bctx, u.ID, u.Username); err != nil {
		s.log.WarnContext(ctx, "EnsureDefaultOrg failed, will retry on next login", slog.String("user_id", u.ID.String()), slog.Any("error", err))
	}
}

func (s *Service) resourceOrg(ctx context.Context, rt rbac.ResourceType, id uuid.UUID) (uuid.UUID, error) {
	bctx, cancel := s.backendCtx(ctx)
	defer cancel()
	org, err := s.backend.ResourceOrg(bctx, rt, id)
	switch {
	case err == nil:
		return org, nil
	case errors.Is(err, ErrBackendNotFound):
		return uuid.UUID{}, notFound("resource not found")
	default:
		return uuid.UUID{}, unavailable("backend is unavailable", err)
	}
}

func rbacBindings(bs []store.RoleBinding) []rbac.Binding {
	out := make([]rbac.Binding, 0, len(bs))
	for _, b := range bs {
		out = append(out, b.RBAC())
	}
	return out
}

func principalBindings(ctx context.Context, tx store.Tx, p store.Principal) ([]store.RoleBinding, error) {
	bs, _, err := tx.ListBindings(ctx, store.BindingFilter{Principal: &p}, store.Page{})
	return bs, err
}

func toResource(rt rbac.ResourceType, id, org uuid.UUID) rbac.Resource {
	return rbac.Resource{Type: rt, ID: id.String(), OrgID: org.String()}
}

func (s *Service) decide(ctx context.Context, tx store.Tx, c Caller, res rbac.Resource, a rbac.Action) (rbac.Decision, error) {
	if c.Type == rbac.PrincipalServiceAccount && res.OrgID != c.OrgID.String() {
		return rbac.Decision{}, nil
	}
	bs, err := principalBindings(ctx, tx, c.Principal())
	if err != nil {
		return rbac.Decision{}, err
	}
	return rbac.Evaluate(res, rbacBindings(bs), a), nil
}

func (s *Service) authorize(ctx context.Context, tx store.Tx, c Caller, res rbac.Resource, a rbac.Action, what string) (rbac.Decision, error) {
	d, err := s.decide(ctx, tx, c, res, a)
	if err != nil {
		return d, err
	}
	if !d.Visible {
		return d, notFound(what + " not found")
	}
	if !d.Allowed {
		return d, forbidden("insufficient role on the " + what)
	}
	return d, nil
}

type BindingView struct {
	store.RoleBinding
	PrincipalName string
}

func principalNames(ctx context.Context, tx store.Tx, bs []store.RoleBinding) (map[store.Principal]string, error) {
	var users, sas []uuid.UUID
	for _, b := range bs {
		switch b.Principal.Type {
		case rbac.PrincipalUser:
			users = append(users, b.Principal.ID)
		case rbac.PrincipalServiceAccount:
			sas = append(sas, b.Principal.ID)
		}
	}
	names := map[store.Principal]string{}
	if len(users) > 0 {
		us, err := tx.UsersByIDs(ctx, users)
		if err != nil {
			return nil, err
		}
		for _, u := range us {
			names[store.Principal{Type: rbac.PrincipalUser, ID: u.ID}] = u.Username
		}
	}
	if len(sas) > 0 {
		list, err := tx.ServiceAccountsByIDs(ctx, sas)
		if err != nil {
			return nil, err
		}
		for _, sa := range list {
			names[store.Principal{Type: rbac.PrincipalServiceAccount, ID: sa.ID}] = sa.Name
		}
	}
	return names, nil
}

func views(ctx context.Context, tx store.Tx, bs []store.RoleBinding) ([]BindingView, error) {
	names, err := principalNames(ctx, tx, bs)
	if err != nil {
		return nil, err
	}
	out := make([]BindingView, 0, len(bs))
	for _, b := range bs {
		out = append(out, BindingView{RoleBinding: b, PrincipalName: names[b.Principal]})
	}
	return out, nil
}

func view(ctx context.Context, tx store.Tx, b store.RoleBinding) (BindingView, error) {
	vs, err := views(ctx, tx, []store.RoleBinding{b})
	if err != nil {
		return BindingView{}, err
	}
	return vs[0], nil
}

func principalsOf(bs []store.RoleBinding) []store.Principal {
	var out []store.Principal
	for _, b := range bs {
		if !slices.Contains(out, b.Principal) {
			out = append(out, b.Principal)
		}
	}
	return out
}

func deleteAndBump(ctx context.Context, tx store.Tx, bs []store.RoleBinding, skip ...store.Principal) ([]store.RoleBinding, error) {
	if len(bs) == 0 {
		return nil, nil
	}
	deleted, err := tx.DeleteBindings(ctx, bindingIDs(bs))
	if err != nil {
		return nil, err
	}
	affected := slices.DeleteFunc(principalsOf(deleted), func(p store.Principal) bool { return slices.Contains(skip, p) })
	if len(affected) > 0 {
		if err := tx.BumpAuthzVersions(ctx, affected); err != nil {
			return nil, err
		}
	}
	return deleted, nil
}

func bindingIDs(bs []store.RoleBinding) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(bs))
	for _, b := range bs {
		out = append(out, b.ID)
	}
	return out
}

func newID() (uuid.UUID, error) {
	return uuid.NewV7()
}

type Page struct {
	Limit  int
	Offset int
}

func (p Page) store() store.Page {
	return store.Page{Limit: p.Limit, Offset: p.Offset}
}

func CheckPage(limit, offset int) (Page, error) {
	if limit < 1 || limit > MaxPageLimit {
		return Page{}, invalid("limit", "must be between 1 and 500")
	}
	if offset < 0 || offset > MaxPageOffset {
		return Page{}, invalid("offset", "must be between 0 and 1000000")
	}
	return Page{Limit: limit, Offset: offset}, nil
}
