package core

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/store"
	"slopdns/web/pkg/rbac"
)

func resourceLabel(rt rbac.ResourceType) string {
	switch rt {
	case rbac.ResourceOrg:
		return "organization"
	case rbac.ResourceZone:
		return "zone"
	}
	return "service account"
}

func (s *Service) resolveResource(ctx context.Context, rt rbac.ResourceType, id uuid.UUID) (rbac.Resource, error) {
	switch rt {
	case rbac.ResourceOrg:
		return toResource(rt, id, id), nil
	case rbac.ResourceZone:
		org, err := s.resourceOrg(ctx, rt, id)
		if err != nil {
			if KindOf(err) == KindNotFound {
				return rbac.Resource{}, notFound("zone not found")
			}
			return rbac.Resource{}, err
		}
		return toResource(rt, id, org), nil
	}
	var res rbac.Resource
	err := s.inTx(ctx, func(tx store.Tx) error {
		var err error
		_, res, err = s.saResource(ctx, tx, id)
		return err
	})
	return res, err
}

func sameResource(ctx context.Context, tx store.Tx, res rbac.Resource) error {
	if res.Type != rbac.ResourceServiceAccount {
		return nil
	}
	id, _ := uuid.Parse(res.ID)
	sa, err := tx.ServiceAccountByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && sa.OrgID.String() != res.OrgID) {
		return notFound("service account not found")
	}
	return err
}

type BindingFilter struct {
	ResourceType *string
	ResourceID   *string
	OrgID        *string
}

func (s *Service) ListRoleBindings(ctx context.Context, c Caller, f BindingFilter, p Page) ([]BindingView, int, error) {
	byResource := f.ResourceType != nil || f.ResourceID != nil
	if byResource && f.OrgID != nil {
		return nil, 0, invalid("org_id", "use either resource_type with resource_id or org_id")
	}
	if !byResource && f.OrgID == nil {
		return nil, 0, invalid("org_id", "resource_type with resource_id or org_id is required")
	}
	var res rbac.Resource
	filter := store.BindingFilter{}
	if byResource {
		if f.ResourceType == nil {
			return nil, 0, invalid("resource_type", "is required with resource_id")
		}
		if f.ResourceID == nil {
			return nil, 0, invalid("resource_id", "is required with resource_type")
		}
		rt, err := ParseResourceType("resource_type", *f.ResourceType)
		if err != nil {
			return nil, 0, err
		}
		rid, err := ParseID("resource_id", *f.ResourceID)
		if err != nil {
			return nil, 0, err
		}
		if res, err = s.resolveResource(ctx, rt, rid); err != nil {
			return nil, 0, err
		}
		org, _ := uuid.Parse(res.OrgID)
		filter = store.BindingFilter{ResourceType: rt, ResourceID: &rid, OrgID: &org}
	} else {
		org, err := ParseID("org_id", *f.OrgID)
		if err != nil {
			return nil, 0, err
		}
		res = toResource(rbac.ResourceOrg, org, org)
		filter = store.BindingFilter{OrgID: &org}
	}
	var out []BindingView
	var total int
	err := s.inTx(ctx, func(tx store.Tx) error {
		if err := sameResource(ctx, tx, res); err != nil {
			return err
		}
		if _, err := s.authorize(ctx, tx, c, res, rbac.ActionRead, resourceLabel(res.Type)); err != nil {
			return err
		}
		bs, n, err := tx.ListBindings(ctx, filter, p.store())
		if err != nil {
			return err
		}
		total = n
		out, err = views(ctx, tx, bs)
		return err
	})
	return out, total, err
}

type BindingInput struct {
	PrincipalType *string
	PrincipalID   *string
	Username      *string
	ResourceType  string
	ResourceID    string
	Role          string
}

type principalRef struct {
	principal store.Principal
	username  string
	field     string
}

func parsePrincipal(in BindingInput) (principalRef, error) {
	if in.Username != nil {
		if in.PrincipalType != nil || in.PrincipalID != nil {
			return principalRef{}, invalid("username", "use either username or principal_type with principal_id")
		}
		if err := checkUsername("username", *in.Username); err != nil {
			return principalRef{}, err
		}
		return principalRef{username: *in.Username, field: "username"}, nil
	}
	if in.PrincipalType == nil {
		return principalRef{}, invalid("principal_type", "is required")
	}
	if in.PrincipalID == nil {
		return principalRef{}, invalid("principal_id", "is required")
	}
	pt, err := ParsePrincipalType("principal_type", *in.PrincipalType)
	if err != nil {
		return principalRef{}, err
	}
	pid, err := ParseID("principal_id", *in.PrincipalID)
	if err != nil {
		return principalRef{}, err
	}
	return principalRef{principal: store.Principal{Type: pt, ID: pid}, field: "principal_id"}, nil
}

func (s *Service) loadPrincipal(ctx context.Context, tx store.Tx, ref principalRef) (store.Principal, *store.ServiceAccount, error) {
	if ref.username != "" {
		u, err := tx.UserByUsername(ctx, ref.username)
		if errors.Is(err, store.ErrNotFound) {
			return store.Principal{}, nil, notFound("user not found")
		}
		if err != nil {
			return store.Principal{}, nil, err
		}
		return store.Principal{Type: rbac.PrincipalUser, ID: u.ID}, nil, nil
	}
	if ref.principal.Type == rbac.PrincipalUser {
		if _, err := tx.UserByID(ctx, ref.principal.ID); errors.Is(err, store.ErrNotFound) {
			return store.Principal{}, nil, notFound("user not found")
		} else if err != nil {
			return store.Principal{}, nil, err
		}
		return ref.principal, nil, nil
	}
	sa, err := tx.ServiceAccountByID(ctx, ref.principal.ID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Principal{}, nil, notFound("service account not found")
	}
	if err != nil {
		return store.Principal{}, nil, err
	}
	return ref.principal, &sa, nil
}

func isMember(ctx context.Context, tx store.Tx, p store.Principal, org uuid.UUID) (bool, error) {
	bs, err := principalBindings(ctx, tx, p)
	if err != nil {
		return false, err
	}
	return rbac.Member(org.String(), rbacBindings(bs)), nil
}

func grantError(err error) error {
	switch {
	case errors.Is(err, rbac.ErrOwnerImmutable):
		return forbidden("the owner binding can only change through ownership transfer")
	case errors.Is(err, rbac.ErrSelfElevation):
		return forbidden("you cannot raise your own role")
	case errors.Is(err, rbac.ErrRoleNotGrantable):
		return invalid("role", "must be one of admin, editor, reader")
	}
	return forbidden("insufficient role to grant this role")
}

func grantedBy(c Caller) *uuid.UUID {
	if !c.IsUser() {
		return nil
	}
	id := c.ID
	return &id
}

func (s *Service) CreateRoleBinding(ctx context.Context, c Caller, in BindingInput) (BindingView, error) {
	ref, err := parsePrincipal(in)
	if err != nil {
		return BindingView{}, err
	}
	rt, err := ParseResourceType("resource_type", in.ResourceType)
	if err != nil {
		return BindingView{}, err
	}
	rid, err := ParseID("resource_id", in.ResourceID)
	if err != nil {
		return BindingView{}, err
	}
	role, err := ParseGrantableRole("role", in.Role)
	if err != nil {
		return BindingView{}, err
	}
	res, err := s.resolveResource(ctx, rt, rid)
	if err != nil {
		return BindingView{}, err
	}
	org, _ := uuid.Parse(res.OrgID)
	var out BindingView
	err = s.inTx(ctx, func(tx store.Tx) error {
		if err := sameResource(ctx, tx, res); err != nil {
			return err
		}
		d, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, resourceLabel(rt))
		if err != nil {
			return err
		}
		p, sa, err := s.loadPrincipal(ctx, tx, ref)
		if err != nil {
			return err
		}
		if sa != nil && sa.OrgID != org {
			return invalid(ref.field, "service accounts can only receive roles on objects of their own organization")
		}
		if p.Type == rbac.PrincipalUser {
			if _, err := tx.LockUser(ctx, p.ID); err != nil {
				return err
			}
			member, err := isMember(ctx, tx, p, org)
			if err != nil {
				return err
			}
			if !member {
				return invalid(ref.field, "the user is not a member of the organization, invite them first")
			}
		}
		existing, err := tx.BindingFor(ctx, p, rt, rid)
		stale := false
		switch {
		case err == nil && existing.OrgID == org:
			return conflict("the principal already has a role on this object, use PATCH to change it")
		case err == nil:
			stale = true
		case !errors.Is(err, store.ErrNotFound):
			return err
		}
		if err := rbac.CheckGrant(rbac.GrantRequest{CallerEffective: d.Effective, TargetIsCaller: p == c.Principal(), NewRole: role}); err != nil {
			return grantError(err)
		}
		now := s.clock()
		b := store.RoleBinding{Principal: p, ResourceType: rt, ResourceID: rid, OrgID: org, Role: role, GrantedBy: grantedBy(c), CreatedAt: now}
		if stale {
			b.ID = existing.ID
			err = tx.UpdateBinding(ctx, b)
		} else {
			if b.ID, err = newID(); err != nil {
				return err
			}
			err = tx.CreateBinding(ctx, b)
		}
		if errors.Is(err, store.ErrConflict) {
			return conflict("the principal already has a role on this object")
		}
		if err != nil {
			return err
		}
		if err := tx.BumpAuthzVersions(ctx, []store.Principal{p}); err != nil {
			return err
		}
		out, err = view(ctx, tx, b)
		return err
	})
	return out, err
}

func (s *Service) loadBindingResource(ctx context.Context, id uuid.UUID) (store.RoleBinding, rbac.Resource, error) {
	var b store.RoleBinding
	if err := s.inTx(ctx, func(tx store.Tx) error {
		var err error
		b, err = tx.BindingByID(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return notFound("role binding not found")
		}
		return err
	}); err != nil {
		return b, rbac.Resource{}, err
	}
	res, err := s.resolveResource(ctx, b.ResourceType, b.ResourceID)
	if err != nil {
		if KindOf(err) == KindNotFound {
			return b, res, notFound("role binding not found")
		}
		return b, res, err
	}
	if res.OrgID != b.OrgID.String() {
		return b, res, notFound("role binding not found")
	}
	return b, res, nil
}

func (s *Service) reloadBinding(ctx context.Context, tx store.Tx, want store.RoleBinding, res rbac.Resource) (store.RoleBinding, error) {
	b, err := tx.BindingByID(ctx, want.ID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && (b.OrgID != want.OrgID || b.ResourceID != want.ResourceID)) {
		return b, notFound("role binding not found")
	}
	if err != nil {
		return b, err
	}
	return b, sameResource(ctx, tx, res)
}

func (s *Service) UpdateRoleBinding(ctx context.Context, c Caller, id uuid.UUID, roleStr string) (BindingView, error) {
	role, err := ParseGrantableRole("role", roleStr)
	if err != nil {
		return BindingView{}, err
	}
	want, res, err := s.loadBindingResource(ctx, id)
	if err != nil {
		return BindingView{}, err
	}
	var out BindingView
	err = s.inTx(ctx, func(tx store.Tx) error {
		b, err := s.reloadBinding(ctx, tx, want, res)
		if err != nil {
			return err
		}
		d, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, resourceLabel(b.ResourceType))
		if err != nil {
			if KindOf(err) == KindNotFound {
				return notFound("role binding not found")
			}
			return err
		}
		if err := rbac.CheckGrant(rbac.GrantRequest{CallerEffective: d.Effective, TargetIsCaller: b.Principal == c.Principal(), ExistingRole: b.Role, NewRole: role}); err != nil {
			return grantError(err)
		}
		if b.Role != role {
			b.Role = role
			b.GrantedBy = grantedBy(c)
			if err := tx.UpdateBinding(ctx, b); err != nil {
				return err
			}
			if err := tx.BumpAuthzVersions(ctx, []store.Principal{b.Principal}); err != nil {
				return err
			}
		}
		out, err = view(ctx, tx, b)
		return err
	})
	return out, err
}

func (s *Service) DeleteRoleBinding(ctx context.Context, c Caller, id uuid.UUID) error {
	want, res, err := s.loadBindingResource(ctx, id)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(tx store.Tx) error {
		b, err := s.reloadBinding(ctx, tx, want, res)
		if err != nil {
			return err
		}
		d, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, resourceLabel(b.ResourceType))
		if err != nil {
			if KindOf(err) == KindNotFound {
				return notFound("role binding not found")
			}
			return err
		}
		if err := rbac.CheckRevoke(d.Effective, b.Role); err != nil {
			return grantError(err)
		}
		deleted, err := deleteAndBump(ctx, tx, []store.RoleBinding{b})
		if err != nil {
			return err
		}
		if len(deleted) == 0 {
			return notFound("role binding not found")
		}
		return nil
	})
}
