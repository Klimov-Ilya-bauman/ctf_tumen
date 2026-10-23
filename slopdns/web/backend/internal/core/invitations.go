package core

import (
	"context"
	"errors"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/outbox"
	"slopdns/web/backend/internal/store"
)

var invitationStatuses = map[string]bool{store.StatusPending: true, store.StatusAccepted: true, store.StatusDeclined: true, store.StatusRevoked: true, store.StatusExpired: true}

func ValidInvitationStatus(s string) bool {
	return s == "" || invitationStatuses[s]
}

func (s *Service) invitationViews(ctx context.Context, list []store.Invitation) ([]InvitationView, error) {
	var ids []string
	for _, v := range list {
		ids = append(ids, v.InviteeUserID, v.InvitedBy)
	}
	names, err := s.lookupUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	owners := map[string]UserRef{}
	out := make([]InvitationView, 0, len(list))
	for _, v := range list {
		owner, ok := owners[v.OrgID]
		if !ok {
			org, err := s.store.Q().GetOrg(ctx, v.OrgID)
			if err != nil {
				return nil, dbError(err)
			}
			if owner, err = s.ownerRef(ctx, org); err != nil {
				return nil, err
			}
			owners[v.OrgID] = owner
		}
		out = append(out, invitationView(v, names, owner))
	}
	return out, nil
}

func (s *Service) invitationView(ctx context.Context, v store.Invitation) (InvitationView, error) {
	views, err := s.invitationViews(ctx, []store.Invitation{v})
	if err != nil {
		return InvitationView{}, err
	}
	return views[0], nil
}

func (s *Service) CreateInvitation(ctx context.Context, p authz.Principal, orgID, username, role string) (InvitationView, error) {
	org, _, _, err := s.requireOrg(ctx, p, orgID, authz.ActionManageAccess)
	if err != nil {
		return InvitationView{}, err
	}
	if err := requireUser(p, "service accounts cannot invite users"); err != nil {
		return InvitationView{}, err
	}
	if !ValidUsername(username) {
		return InvitationView{}, invalid("username", "must be a valid username")
	}
	r, ok := authz.ParseGrantable(role)
	if !ok {
		return InvitationView{}, invalid("role", "must be admin, editor or reader")
	}
	inviteeID, found, err := s.userByName(ctx, username)
	if err != nil {
		return InvitationView{}, err
	}
	if !found {
		return InvitationView{}, invalid("username", "user not found")
	}
	members, err := s.orgMembers(ctx, org.ID)
	if err != nil {
		return InvitationView{}, err
	}
	if m := findMember(members, iamv1.PrincipalType_PRINCIPAL_TYPE_USER, inviteeID); m != nil && m.orgRole != authz.RoleNone {
		return InvitationView{}, conflict("the user is already a member of the organization")
	}
	if err := s.expireLazily(ctx); err != nil {
		return InvitationView{}, err
	}
	now := s.now()
	var v store.Invitation
	err = s.store.InTx(ctx, func(q *store.Q) error {
		if _, err := q.LockOrg(ctx, org.ID); err != nil {
			return err
		}
		if n, err := q.CountPendingInvitations(ctx, org.ID); err != nil {
			return err
		} else if n >= s.limits.MaxPendingInvitationsPerOrg {
			return quotaExceeded("org_id", "pending invitations per organization", s.limits.MaxPendingInvitationsPerOrg)
		}
		var err error
		v, err = q.InsertInvitation(ctx, store.Invitation{ID: newID(), OrgID: org.ID, InviteeUserID: inviteeID, Role: authz.RoleName(r), InvitedBy: p.ID, CreatedAt: now, ExpiresAt: now.Add(InvitationTTL)})
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return InvitationView{}, notFound("organization")
	}
	if store.IsUnique(err, store.InvitationsPendingKey) {
		return InvitationView{}, conflict("the user already has a pending invitation to this organization")
	}
	if err != nil {
		return InvitationView{}, dbError(err)
	}
	return s.invitationView(ctx, v)
}

func (s *Service) ListOrgInvitations(ctx context.Context, p authz.Principal, orgID, status string, pr PageReq) (Page[InvitationView], error) {
	if _, _, _, err := s.requireOrg(ctx, p, orgID, authz.ActionManageAccess); err != nil {
		return Page[InvitationView]{}, err
	}
	return s.listInvitations(ctx, store.InvitationFilter{OrgID: orgID, Status: status}, pr)
}

func (s *Service) ListMyInvitations(ctx context.Context, p authz.Principal, status string, pr PageReq) (Page[InvitationView], error) {
	if err := requireUser(p, "service accounts have no invitations"); err != nil {
		return Page[InvitationView]{}, err
	}
	return s.listInvitations(ctx, store.InvitationFilter{InviteeID: p.ID, Status: status}, pr)
}

func (s *Service) listInvitations(ctx context.Context, f store.InvitationFilter, pr PageReq) (Page[InvitationView], error) {
	if err := s.expireLazily(ctx); err != nil {
		return Page[InvitationView]{}, err
	}
	list, total, err := s.store.Q().ListInvitations(ctx, f, pr.Limit, pr.Offset)
	if err != nil {
		return Page[InvitationView]{}, dbError(err)
	}
	views, err := s.invitationViews(ctx, list)
	if err != nil {
		return Page[InvitationView]{}, err
	}
	return newPage(views, total, pr), nil
}

func (s *Service) loadInvitation(ctx context.Context, p authz.Principal, id string) (store.Invitation, bool, bool, error) {
	if err := s.expireLazily(ctx); err != nil {
		return store.Invitation{}, false, false, err
	}
	v, err := s.store.Q().GetInvitation(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return store.Invitation{}, false, false, notFound("invitation")
	}
	if err != nil {
		return store.Invitation{}, false, false, dbError(err)
	}
	invitee := p.IsUser() && v.InviteeUserID == p.ID
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return store.Invitation{}, false, false, err
	}
	admin := authz.AllowedOrg(authz.OrgRole(bs, v.OrgID), authz.ActionManageAccess)
	if !invitee && !admin {
		return store.Invitation{}, false, false, notFound("invitation")
	}
	return v, invitee, admin, nil
}

func (s *Service) decideInvitation(ctx context.Context, id, status string, enqueue func(q *store.Q, v store.Invitation) ([]string, error)) (store.Invitation, []string, error) {
	var out store.Invitation
	var ids []string
	err := s.store.InTx(ctx, func(q *store.Q) error {
		v, err := q.LockInvitation(ctx, id)
		if err != nil {
			return err
		}
		if v.Status != store.StatusPending {
			return conflict("the invitation is " + v.Status)
		}
		if !v.ExpiresAt.After(s.now()) {
			return conflict("the invitation has expired")
		}
		if err := q.DecideInvitation(ctx, id, status, s.now()); err != nil {
			return err
		}
		if enqueue != nil {
			if ids, err = enqueue(q, v); err != nil {
				return err
			}
		}
		out, err = q.GetInvitation(ctx, id)
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return store.Invitation{}, nil, notFound("invitation")
	}
	if errors.Is(err, store.ErrConflict) {
		return store.Invitation{}, nil, conflict("the invitation is no longer pending")
	}
	if err != nil {
		return store.Invitation{}, nil, dbError(err)
	}
	return out, ids, nil
}

func (s *Service) AcceptInvitation(ctx context.Context, p authz.Principal, id string) (InvitationView, error) {
	v, invitee, _, err := s.loadInvitation(ctx, p, id)
	if err != nil {
		return InvitationView{}, err
	}
	if !invitee {
		return InvitationView{}, forbidden("only the invitee can accept the invitation")
	}
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return InvitationView{}, err
	}
	if v.Status == store.StatusPending && authz.OrgRole(bs, v.OrgID) != authz.RoleNone {
		return InvitationView{}, conflict("you are already a member of the organization")
	}
	role, _ := authz.ParseGrantable(v.Role)
	out, ids, err := s.decideInvitation(ctx, id, store.StatusAccepted, func(q *store.Q, v store.Invitation) ([]string, error) {
		kind, pl := outbox.Grant(p.Proto(), &iamv1.ResourceRef{Type: iamv1.ResourceType_RESOURCE_TYPE_ORG, Id: v.OrgID, OrgId: v.OrgID}, authz.ProtoRole(role), v.InvitedBy, false)
		oid, err := outbox.Enqueue(ctx, q, kind, pl)
		return []string{oid}, err
	})
	if err != nil {
		return InvitationView{}, err
	}
	s.afterCommit(ctx, ids)
	s.authz.Invalidate(p)
	return s.invitationView(ctx, out)
}

func (s *Service) DeclineInvitation(ctx context.Context, p authz.Principal, id string) (InvitationView, error) {
	_, invitee, _, err := s.loadInvitation(ctx, p, id)
	if err != nil {
		return InvitationView{}, err
	}
	if !invitee {
		return InvitationView{}, forbidden("only the invitee can decline the invitation")
	}
	out, _, err := s.decideInvitation(ctx, id, store.StatusDeclined, nil)
	if err != nil {
		return InvitationView{}, err
	}
	return s.invitationView(ctx, out)
}

func (s *Service) RevokeInvitation(ctx context.Context, p authz.Principal, id string) (InvitationView, error) {
	_, _, admin, err := s.loadInvitation(ctx, p, id)
	if err != nil {
		return InvitationView{}, err
	}
	if !admin {
		return InvitationView{}, forbidden("admin role on the organization is required")
	}
	out, _, err := s.decideInvitation(ctx, id, store.StatusRevoked, nil)
	if err != nil {
		return InvitationView{}, err
	}
	return s.invitationView(ctx, out)
}
