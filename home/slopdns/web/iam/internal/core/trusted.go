package core

import (
	"context"
	"encoding/base64"
	"errors"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/token"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/rbac"
)

type Introspection struct {
	Active           bool
	Principal        store.Principal
	Name             string
	OrgID            uuid.UUID
	Kind             token.Kind
	Assertion        string
	AssertionExpires time.Time
	AuthzVersion     int64
}

func (s *Service) Introspect(ctx context.Context, raw string) (Introspection, error) {
	tok, ok := introspectable(raw)
	if !ok {
		return Introspection{}, nil
	}
	now := s.clock()
	stale := now.Add(-s.cfg.TouchInterval)
	var out Introspection
	err := s.inTx(ctx, func(tx store.Tx) error {
		switch tok.Kind {
		case token.KindSession:
			sess, err := tx.SessionByID(ctx, tok.ID)
			if err != nil || !token.Equal(sess.SecretHash, tok.Secret) || !sessionActive(sess, now) {
				return ignoreNotFound(err)
			}
			u, err := tx.UserByID(ctx, sess.UserID)
			if err != nil {
				return ignoreNotFound(err)
			}
			exp := now.Add(s.cfg.SessionTTL)
			if exp.After(sess.AbsoluteExpiresAt) {
				exp = sess.AbsoluteExpiresAt
			}
			if err := tx.TouchSession(ctx, sess.ID, now, exp, stale); err != nil {
				return err
			}
			out = Introspection{Active: true, Principal: store.Principal{Type: rbac.PrincipalUser, ID: u.ID}, Name: u.Username, AuthzVersion: u.AuthzVersion}
		case token.KindUserAPI, token.KindServiceAccount:
			t, err := tx.APITokenByID(ctx, tok.ID)
			if err != nil || !token.Equal(t.SecretHash, tok.Secret) || t.RevokedAt != nil || (t.ExpiresAt != nil && !now.Before(*t.ExpiresAt)) {
				return ignoreNotFound(err)
			}
			if tok.Kind == token.KindUserAPI {
				if t.OwnerType != store.OwnerUser {
					return nil
				}
				u, err := tx.UserByID(ctx, t.OwnerID)
				if err != nil {
					return ignoreNotFound(err)
				}
				out = Introspection{Active: true, Principal: store.Principal{Type: rbac.PrincipalUser, ID: u.ID}, Name: u.Username, AuthzVersion: u.AuthzVersion}
			} else {
				if t.OwnerType != store.OwnerServiceAccount {
					return nil
				}
				sa, err := tx.ServiceAccountByID(ctx, t.OwnerID)
				if err != nil {
					return ignoreNotFound(err)
				}
				out = Introspection{Active: true, Principal: store.Principal{Type: rbac.PrincipalServiceAccount, ID: sa.ID}, Name: sa.Name, OrgID: sa.OrgID, AuthzVersion: sa.AuthzVersion}
			}
			if err := tx.TouchAPIToken(ctx, t.ID, now, stale); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil || !out.Active {
		return Introspection{}, err
	}
	out.Kind = tok.Kind
	org := ""
	if out.Principal.Type == rbac.PrincipalServiceAccount {
		org = out.OrgID.String()
	}
	out.Assertion, out.AssertionExpires, err = s.issuer.IssueVersioned(out.Principal.ID.String(), assertion.PrincipalType(out.Principal.Type), org, out.AuthzVersion)
	if err != nil {
		return Introspection{}, internal(err)
	}
	return out, nil
}

var errNotMember = errors.New("principal is not a member of the organization")

func introspectable(raw string) (token.Token, bool) {
	tok, err := token.Parse(raw)
	return tok, err == nil && tok.Kind != token.KindMFA
}

func ignoreNotFound(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	return err
}

type ResourceRef struct {
	Type  rbac.ResourceType
	ID    uuid.UUID
	OrgID *uuid.UUID
}

func (s *Service) resourceForCheck(ctx context.Context, tx store.Tx, ref ResourceRef) (rbac.Resource, bool, error) {
	switch ref.Type {
	case rbac.ResourceOrg:
		if ref.OrgID != nil && *ref.OrgID != ref.ID {
			return rbac.Resource{}, false, invalid("resource.org_id", "must equal resource.id for organizations")
		}
		return toResource(ref.Type, ref.ID, ref.ID), true, nil
	case rbac.ResourceZone:
		if ref.OrgID == nil {
			return rbac.Resource{}, false, invalid("resource.org_id", "is required for zones")
		}
		return toResource(ref.Type, ref.ID, *ref.OrgID), true, nil
	}
	sa, err := tx.ServiceAccountByID(ctx, ref.ID)
	if errors.Is(err, store.ErrNotFound) {
		return rbac.Resource{}, false, nil
	}
	if err != nil {
		return rbac.Resource{}, false, err
	}
	if ref.OrgID != nil && *ref.OrgID != sa.OrgID {
		return rbac.Resource{}, false, nil
	}
	return toResource(ref.Type, sa.ID, sa.OrgID), true, nil
}

func (s *Service) principalCaller(ctx context.Context, tx store.Tx, p store.Principal) (Caller, bool, error) {
	c := Caller{Type: p.Type, ID: p.ID}
	if p.Type != rbac.PrincipalServiceAccount {
		return c, true, nil
	}
	sa, err := tx.ServiceAccountByID(ctx, p.ID)
	if errors.Is(err, store.ErrNotFound) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	c.OrgID = sa.OrgID
	return c, true, nil
}

func (s *Service) Check(ctx context.Context, p store.Principal, a rbac.Action, ref ResourceRef) (bool, rbac.Role, error) {
	if !a.Valid() {
		return false, rbac.RoleNone, invalid("action", "is required")
	}
	if !rbac.ActionAllowedOn(ref.Type, a) {
		return false, rbac.RoleNone, invalid("action", "OWN applies only to organizations")
	}
	var d rbac.Decision
	err := s.inTx(ctx, func(tx store.Tx) error {
		res, ok, err := s.resourceForCheck(ctx, tx, ref)
		if err != nil || !ok {
			return err
		}
		c, ok, err := s.principalCaller(ctx, tx, p)
		if err != nil || !ok {
			return err
		}
		d, err = s.decide(ctx, tx, c, res, a)
		return err
	})
	return d.Allowed, d.Effective, err
}

type OrgRole struct {
	OrgID uuid.UUID
	Role  rbac.Role
}

type ResourceRole struct {
	ResourceID uuid.UUID
	OrgID      uuid.UUID
	Role       rbac.Role
}

type Accessible struct {
	OrgRoles      []OrgRole
	ResourceRoles []ResourceRole
	MemberOrgIDs  []uuid.UUID
	AuthzVersion  int64
}

func (s *Service) principalVersion(ctx context.Context, tx store.Tx, p store.Principal) (int64, bool, error) {
	if p.Type == rbac.PrincipalUser {
		u, err := tx.UserByID(ctx, p.ID)
		if errors.Is(err, store.ErrNotFound) {
			return 0, false, nil
		}
		return u.AuthzVersion, err == nil, err
	}
	sa, err := tx.ServiceAccountByID(ctx, p.ID)
	if errors.Is(err, store.ErrNotFound) {
		return 0, false, nil
	}
	return sa.AuthzVersion, err == nil, err
}

func (s *Service) ListAccessible(ctx context.Context, p store.Principal, rt rbac.ResourceType) (Accessible, error) {
	var out Accessible
	err := s.inTx(ctx, func(tx store.Tx) error {
		v, ok, err := s.principalVersion(ctx, tx, p)
		if err != nil || !ok {
			return err
		}
		out.AuthzVersion = v
		bs, err := principalBindings(ctx, tx, p)
		if err != nil {
			return err
		}
		seen := map[uuid.UUID]bool{}
		for _, b := range bs {
			switch b.ResourceType {
			case rbac.ResourceOrg:
				out.OrgRoles = append(out.OrgRoles, OrgRole{OrgID: b.OrgID, Role: b.Role})
			case rt:
				out.ResourceRoles = append(out.ResourceRoles, ResourceRole{ResourceID: b.ResourceID, OrgID: b.OrgID, Role: b.Role})
			}
			if !seen[b.OrgID] {
				seen[b.OrgID] = true
				out.MemberOrgIDs = append(out.MemberOrgIDs, b.OrgID)
			}
		}
		sort.Slice(out.MemberOrgIDs, func(i, j int) bool { return out.MemberOrgIDs[i].String() < out.MemberOrgIDs[j].String() })
		return nil
	})
	return out, err
}

type GrantInput struct {
	Principal       store.Principal
	Resource        ResourceRef
	Role            rbac.Role
	GrantedBy       *uuid.UUID
	ReplaceExisting bool
}

func (s *Service) trustedResource(ctx context.Context, tx store.Tx, ref ResourceRef) (uuid.UUID, error) {
	switch ref.Type {
	case rbac.ResourceOrg:
		if ref.OrgID != nil && *ref.OrgID != ref.ID {
			return uuid.UUID{}, invalid("resource.org_id", "must equal resource.id for organizations")
		}
		return ref.ID, nil
	case rbac.ResourceZone:
		if ref.OrgID == nil {
			return uuid.UUID{}, invalid("resource.org_id", "is required for zones")
		}
		return *ref.OrgID, nil
	}
	sa, err := tx.ServiceAccountByID(ctx, ref.ID)
	if errors.Is(err, store.ErrNotFound) {
		return uuid.UUID{}, notFound("service account not found")
	}
	if err != nil {
		return uuid.UUID{}, err
	}
	if ref.OrgID != nil && *ref.OrgID != sa.OrgID {
		return uuid.UUID{}, precondition("service account belongs to another organization")
	}
	return sa.OrgID, nil
}

func (s *Service) requirePrincipal(ctx context.Context, tx store.Tx, p store.Principal, org uuid.UUID) error {
	if p.Type == rbac.PrincipalUser {
		if _, err := tx.LockUser(ctx, p.ID); errors.Is(err, store.ErrNotFound) {
			return notFound("user not found")
		} else if err != nil {
			return err
		}
		return nil
	}
	sa, err := tx.ServiceAccountByID(ctx, p.ID)
	if errors.Is(err, store.ErrNotFound) {
		return notFound("service account not found")
	}
	if err != nil {
		return err
	}
	if sa.OrgID != org {
		return precondition("service accounts can only receive roles in their own organization")
	}
	return nil
}

func (s *Service) Grant(ctx context.Context, in GrantInput) (BindingView, bool, error) {
	if !rbac.Grantable(in.Role) {
		return BindingView{}, false, invalid("role", "must be READER, EDITOR or ADMIN")
	}
	var out BindingView
	created := false
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		out, created, err = s.grantOnce(ctx, in)
		if !errors.Is(err, store.ErrConflict) && !errors.Is(err, store.ErrOwnerConflict) {
			break
		}
	}
	if errors.Is(err, store.ErrConflict) || errors.Is(err, store.ErrOwnerConflict) {
		return BindingView{}, false, unavailable("concurrent updates of the same binding, retry", err)
	}
	return out, created, err
}

func (s *Service) grantOnce(ctx context.Context, in GrantInput) (BindingView, bool, error) {
	var out BindingView
	created := false
	err := s.inTx(ctx, func(tx store.Tx) error {
		org, err := s.trustedResource(ctx, tx, in.Resource)
		if err != nil {
			return err
		}
		if err := s.requirePrincipal(ctx, tx, in.Principal, org); err != nil {
			return err
		}
		if !in.ReplaceExisting && in.Resource.Type != rbac.ResourceOrg && in.Principal.Type == rbac.PrincipalUser {
			member, err := isMember(ctx, tx, in.Principal, org)
			if err != nil {
				return err
			}
			if !member {
				return &Error{Kind: KindFailedPrecondition, Message: "the user is not a member of the organization, invite them first", cause: errNotMember}
			}
		}
		now := s.clock()
		existing, err := tx.BindingFor(ctx, in.Principal, in.Resource.Type, in.Resource.ID)
		var b store.RoleBinding
		switch {
		case errors.Is(err, store.ErrNotFound):
			id, err := newID()
			if err != nil {
				return err
			}
			b = store.RoleBinding{ID: id, Principal: in.Principal, ResourceType: in.Resource.Type, ResourceID: in.Resource.ID, OrgID: org, Role: in.Role, GrantedBy: in.GrantedBy, CreatedAt: now}
			if err := tx.CreateBinding(ctx, b); err != nil {
				return err
			}
			created = true
		case err != nil:
			return err
		case existing.OrgID != org:
			if !in.ReplaceExisting {
				return conflict("the principal has a binding on this object from another organization")
			}
			b = existing
			b.OrgID, b.Role, b.GrantedBy, b.CreatedAt = org, in.Role, in.GrantedBy, now
			if err := tx.UpdateBinding(ctx, b); err != nil {
				return err
			}
			created = true
		case existing.Role == in.Role:
			out, err = view(ctx, tx, existing)
			return err
		case existing.Role == rbac.RoleOwner:
			return precondition("the owner binding cannot be replaced")
		case !in.ReplaceExisting:
			return conflict("the principal already has another role on this object")
		default:
			b = existing
			b.Role, b.GrantedBy = in.Role, in.GrantedBy
			if err := tx.UpdateBinding(ctx, b); err != nil {
				return err
			}
		}
		if err := tx.BumpAuthzVersions(ctx, []store.Principal{in.Principal}); err != nil {
			return err
		}
		out, err = view(ctx, tx, b)
		return err
	})
	return out, created, err
}

func (s *Service) RevokeBinding(ctx context.Context, id uuid.UUID) (int, error) {
	n := 0
	err := s.inTx(ctx, func(tx store.Tx) error {
		b, err := tx.BindingByID(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if b.Role == rbac.RoleOwner {
			return precondition("the owner binding cannot be revoked")
		}
		deleted, err := deleteAndBump(ctx, tx, []store.RoleBinding{b})
		n = len(deleted)
		return err
	})
	return n, err
}

func (s *Service) RevokePrincipalInOrg(ctx context.Context, p store.Principal, org uuid.UUID) (int, error) {
	n := 0
	err := s.inTx(ctx, func(tx store.Tx) error {
		if err := lockUsers(ctx, tx, []store.Principal{p}); err != nil {
			return err
		}
		bs, _, err := tx.ListBindings(ctx, store.BindingFilter{Principal: &p, OrgID: &org}, store.Page{})
		if err != nil {
			return err
		}
		for _, b := range bs {
			if b.Role == rbac.RoleOwner {
				return precondition("the owner cannot be removed from the organization")
			}
		}
		deleted, err := deleteAndBump(ctx, tx, bs)
		n = len(deleted)
		return err
	})
	return n, err
}

func (s *Service) RevokeResource(ctx context.Context, ref ResourceRef) (int, error) {
	if ref.Type == rbac.ResourceOrg && ref.OrgID != nil && *ref.OrgID != ref.ID {
		return 0, invalid("resource.org_id", "must equal resource.id for organizations")
	}
	n := 0
	err := s.inTx(ctx, func(tx store.Tx) error {
		if ref.Type == rbac.ResourceOrg {
			return s.revokeOrg(ctx, tx, ref.ID, &n)
		}
		id := ref.ID
		bs, _, err := tx.ListBindings(ctx, store.BindingFilter{ResourceType: ref.Type, ResourceID: &id, OrgID: ref.OrgID}, store.Page{})
		if err != nil {
			return err
		}
		deleted, err := deleteAndBump(ctx, tx, bs)
		n = len(deleted)
		return err
	})
	return n, err
}

func lockUsers(ctx context.Context, tx store.Tx, ps []store.Principal) error {
	var ids []uuid.UUID
	for _, p := range ps {
		if p.Type == rbac.PrincipalUser && !slices.Contains(ids, p.ID) {
			ids = append(ids, p.ID)
		}
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	for _, id := range ids {
		if _, err := tx.LockUser(ctx, id); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	return nil
}

func (s *Service) revokeOrg(ctx context.Context, tx store.Tx, org uuid.UUID, n *int) error {
	first, _, err := tx.ListBindings(ctx, store.BindingFilter{OrgID: &org}, store.Page{})
	if err != nil {
		return err
	}
	if err := lockUsers(ctx, tx, principalsOf(first)); err != nil {
		return err
	}
	bs, _, err := tx.ListBindings(ctx, store.BindingFilter{OrgID: &org}, store.Page{})
	if err != nil {
		return err
	}
	saIDs, err := tx.ServiceAccountIDsByOrg(ctx, org)
	if err != nil {
		return err
	}
	skip := make([]store.Principal, 0, len(saIDs))
	for _, id := range saIDs {
		skip = append(skip, store.Principal{Type: rbac.PrincipalServiceAccount, ID: id})
	}
	deleted, err := deleteAndBump(ctx, tx, bs, skip...)
	if err != nil {
		return err
	}
	*n = len(deleted)
	for _, id := range saIDs {
		sa, err := tx.ServiceAccountByID(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if _, err := deleteServiceAccount(ctx, tx, sa); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	return nil
}

type BindingsResult struct {
	Bindings     []BindingView
	AuthzVersion int64
}

type ListBindingsQuery struct {
	Resource  *ResourceRef
	OrgID     *uuid.UUID
	Principal *store.Principal
}

func (s *Service) ListBindings(ctx context.Context, q ListBindingsQuery) (BindingsResult, error) {
	var f store.BindingFilter
	switch {
	case q.Resource != nil:
		id := q.Resource.ID
		f = store.BindingFilter{ResourceType: q.Resource.Type, ResourceID: &id, OrgID: q.Resource.OrgID}
	case q.OrgID != nil:
		f = store.BindingFilter{OrgID: q.OrgID}
	case q.Principal != nil:
		f = store.BindingFilter{Principal: q.Principal}
	default:
		return BindingsResult{}, invalid("filter", "is required")
	}
	var out BindingsResult
	err := s.inTx(ctx, func(tx store.Tx) error {
		if q.Principal != nil {
			v, _, err := s.principalVersion(ctx, tx, *q.Principal)
			if err != nil {
				return err
			}
			out.AuthzVersion = v
		}
		bs, _, err := tx.ListBindings(ctx, f, store.Page{})
		if err != nil {
			return err
		}
		out.Bindings, err = views(ctx, tx, bs)
		return err
	})
	return out, err
}

func (s *Service) TransferOwnership(ctx context.Context, org, from, to uuid.UUID) (BindingView, BindingView, error) {
	if from == to {
		return BindingView{}, BindingView{}, invalid("to_user_id", "must differ from from_user_id")
	}
	var newOwner, prev BindingView
	err := s.inTx(ctx, func(tx store.Tx) error {
		owner, err := tx.OrgOwner(ctx, org, true)
		if errors.Is(err, store.ErrNotFound) {
			return precondition("the organization has no owner")
		}
		if err != nil {
			return err
		}
		fromP := store.Principal{Type: rbac.PrincipalUser, ID: from}
		toP := store.Principal{Type: rbac.PrincipalUser, ID: to}
		if owner.Principal == toP {
			fb, err := tx.BindingFor(ctx, fromP, rbac.ResourceOrg, org)
			if err != nil || fb.Role != rbac.RoleAdmin {
				return precondition("from_user_id is not the current owner")
			}
			vs, err := views(ctx, tx, []store.RoleBinding{owner, fb})
			if err != nil {
				return err
			}
			newOwner, prev = vs[0], vs[1]
			return nil
		}
		if owner.Principal != fromP {
			return precondition("from_user_id is not the current owner")
		}
		if _, err := tx.UserByID(ctx, to); errors.Is(err, store.ErrNotFound) {
			return precondition("the new owner must be a user member of the organization")
		} else if err != nil {
			return err
		}
		member, err := isMember(ctx, tx, toP, org)
		if err != nil {
			return err
		}
		if !member {
			return precondition("the new owner must be a user member of the organization")
		}
		owner.Role = rbac.RoleAdmin
		if err := tx.UpdateBinding(ctx, owner); err != nil {
			return err
		}
		tb, err := tx.BindingFor(ctx, toP, rbac.ResourceOrg, org)
		now := s.clock()
		switch {
		case errors.Is(err, store.ErrNotFound):
			id, err := newID()
			if err != nil {
				return err
			}
			tb = store.RoleBinding{ID: id, Principal: toP, ResourceType: rbac.ResourceOrg, ResourceID: org, OrgID: org, Role: rbac.RoleOwner, GrantedBy: &from, CreatedAt: now}
			if err := tx.CreateBinding(ctx, tb); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			tb.Role = rbac.RoleOwner
			tb.GrantedBy = &from
			if err := tx.UpdateBinding(ctx, tb); err != nil {
				return err
			}
		}
		if err := tx.BumpAuthzVersions(ctx, []store.Principal{fromP, toP}); err != nil {
			return err
		}
		vs, err := views(ctx, tx, []store.RoleBinding{tb, owner})
		if err != nil {
			return err
		}
		newOwner, prev = vs[0], vs[1]
		return nil
	})
	return newOwner, prev, err
}

func (s *Service) CreateOrgOwner(ctx context.Context, org, user uuid.UUID) (BindingView, bool, error) {
	var out BindingView
	created := false
	attempt := func() error {
		return s.inTx(ctx, func(tx store.Tx) error {
			if _, err := tx.UserByID(ctx, user); errors.Is(err, store.ErrNotFound) {
				return notFound("user not found")
			} else if err != nil {
				return err
			}
			p := store.Principal{Type: rbac.PrincipalUser, ID: user}
			owner, err := tx.OrgOwner(ctx, org, true)
			switch {
			case err == nil && owner.Principal == p:
				out, err = view(ctx, tx, owner)
				return err
			case err == nil:
				return precondition("the organization already has another owner")
			case !errors.Is(err, store.ErrNotFound):
				return err
			}
			now := s.clock()
			b, err := tx.BindingFor(ctx, p, rbac.ResourceOrg, org)
			switch {
			case errors.Is(err, store.ErrNotFound):
				id, err := newID()
				if err != nil {
					return err
				}
				b = store.RoleBinding{ID: id, Principal: p, ResourceType: rbac.ResourceOrg, ResourceID: org, OrgID: org, Role: rbac.RoleOwner, CreatedAt: now}
				err = tx.CreateBinding(ctx, b)
				if err != nil {
					return err
				}
			case err != nil:
				return err
			default:
				b.Role = rbac.RoleOwner
				if err := tx.UpdateBinding(ctx, b); err != nil {
					return err
				}
			}
			created = true
			if err := tx.BumpAuthzVersions(ctx, []store.Principal{p}); err != nil {
				return err
			}
			out, err = view(ctx, tx, b)
			return err
		})
	}
	err := attempt()
	if errors.Is(err, store.ErrOwnerConflict) || errors.Is(err, store.ErrConflict) {
		created = false
		err = attempt()
		if errors.Is(err, store.ErrOwnerConflict) || errors.Is(err, store.ErrConflict) {
			return BindingView{}, false, precondition("the organization already has another owner")
		}
	}
	return out, created, err
}

func (s *Service) LookupUsers(ctx context.Context, ids []uuid.UUID, names []string) ([]store.User, error) {
	if len(ids) > MaxLookup || len(names) > MaxLookup {
		return nil, invalid("user_ids", "at most 1000 ids and 1000 usernames per request")
	}
	for i, n := range names {
		if !ValidUsername(n) {
			return nil, invalid("usernames["+itoa(i)+"]", "invalid username")
		}
	}
	out := []store.User{}
	err := s.inTx(ctx, func(tx store.Tx) error {
		seen := map[uuid.UUID]bool{}
		add := func(us []store.User) {
			for _, u := range us {
				if !seen[u.ID] {
					seen[u.ID] = true
					out = append(out, u)
				}
			}
		}
		if len(ids) > 0 {
			us, err := tx.UsersByIDs(ctx, ids)
			if err != nil {
				return err
			}
			add(us)
		}
		if len(names) > 0 {
			us, err := tx.UsersByUsernames(ctx, names)
			if err != nil {
				return err
			}
			add(us)
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out, err
}

func itoa(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{digits[i%10]}, b...)
		i /= 10
	}
	return string(b)
}

const (
	DefaultListPage = 500
	MaxListPage     = 1000
)

func pageSize(n int) (int, error) {
	if n == 0 {
		return DefaultListPage, nil
	}
	if n < 0 || n > MaxListPage {
		return 0, invalid("page_size", "must be between 1 and 1000")
	}
	return n, nil
}

func encodeCursor(parts ...string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strings.Join(parts, "|")))
}

func decodeCursor(tok string, n int) ([]string, error) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(tok)
	if err != nil {
		return nil, invalid("page_token", "is malformed")
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != n {
		return nil, invalid("page_token", "is malformed")
	}
	return parts, nil
}

func (s *Service) ListBindingResources(ctx context.Context, rt rbac.ResourceType, size int, pageToken string) ([]store.BindingResource, string, error) {
	if rt != "" && !rt.Valid() {
		return nil, "", invalid("resource_type", "is invalid")
	}
	limit, err := pageSize(size)
	if err != nil {
		return nil, "", err
	}
	var after *store.BindingResourceKey
	if pageToken != "" {
		parts, err := decodeCursor(pageToken, 3)
		if err != nil {
			return nil, "", err
		}
		k := store.BindingResourceKey{ResourceType: rbac.ResourceType(parts[0])}
		var e1, e2 error
		k.ResourceID, e1 = token.ParseID(parts[1])
		k.OrgID, e2 = token.ParseID(parts[2])
		if !k.ResourceType.Valid() || e1 != nil || e2 != nil {
			return nil, "", invalid("page_token", "is malformed")
		}
		after = &k
	}
	var out []store.BindingResource
	err = s.inTx(ctx, func(tx store.Tx) error {
		var err error
		out, err = tx.ListBindingResources(ctx, rt, after, limit)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) == limit {
		k := out[len(out)-1].Key()
		next = encodeCursor(string(k.ResourceType), k.ResourceID.String(), k.OrgID.String())
	}
	return out, next, nil
}

func (s *Service) ListServiceAccountRefs(ctx context.Context, size int, pageToken string) ([]store.ServiceAccount, string, error) {
	limit, err := pageSize(size)
	if err != nil {
		return nil, "", err
	}
	var after *uuid.UUID
	if pageToken != "" {
		parts, err := decodeCursor(pageToken, 1)
		if err != nil {
			return nil, "", err
		}
		id, perr := token.ParseID(parts[0])
		if perr != nil {
			return nil, "", invalid("page_token", "is malformed")
		}
		after = &id
	}
	var out []store.ServiceAccount
	err = s.inTx(ctx, func(tx store.Tx) error {
		var err error
		out, err = tx.ListServiceAccountRefs(ctx, after, limit)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) == limit {
		next = encodeCursor(out[len(out)-1].ID.String())
	}
	return out, next, nil
}
