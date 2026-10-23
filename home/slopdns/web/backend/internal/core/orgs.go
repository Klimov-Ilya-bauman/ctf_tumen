package core

import (
	"context"
	"errors"
	"sort"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/outbox"
	"slopdns/web/backend/internal/store"
)

var (
	ErrInvalidArgument = errors.New("invalid argument")
	ErrNotFound        = errors.New("not found")
)

func (s *Service) EnsureDefaultOrg(ctx context.Context, userID, username string) (store.Org, bool, error) {
	if !ValidUUID(userID) || !ValidUsername(username) {
		return store.Org{}, false, ErrInvalidArgument
	}
	q := s.store.Q()
	if org, err := q.GetDefaultOrg(ctx, userID); err == nil {
		return org, false, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.Org{}, false, err
	}
	var org store.Org
	var ids []string
	uid := userID
	err := s.store.InTx(ctx, func(tq *store.Q) error {
		if err := tq.LockUserOrgQuota(ctx, userID); err != nil {
			return err
		}
		var err error
		org, err = tq.InsertOrg(ctx, store.Org{ID: newID(), Name: DefaultOrgName(username), DefaultForUserID: &uid, CreatedBy: userID})
		if err != nil {
			return err
		}
		kind, p := outbox.CreateOrgOwner(org.ID, userID)
		id, err := outbox.Enqueue(ctx, tq, kind, p)
		ids = append(ids, id)
		return err
	})
	if store.IsUnique(err, store.OrgsDefaultUserKey) {
		org, err := q.GetDefaultOrg(ctx, userID)
		return org, false, err
	}
	if err != nil {
		return store.Org{}, false, err
	}
	s.afterCommit(ctx, ids)
	return org, true, nil
}

func DefaultOrgName(username string) string {
	return username + "-org"
}

func (s *Service) GetResourceOrg(ctx context.Context, rtype string, id string) (string, error) {
	if !ValidUUID(id) {
		return "", ErrInvalidArgument
	}
	q := s.store.Q()
	switch rtype {
	case "org":
		org, err := q.GetOrg(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return "", ErrNotFound
		}
		return org.ID, err
	case "zone":
		z, err := q.GetZone(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return "", ErrNotFound
		}
		return z.OrgID, err
	}
	return "", ErrInvalidArgument
}

func (s *Service) ownerRef(ctx context.Context, org store.Org) (UserRef, error) {
	resp, err := s.iam.ListBindings(ctx, &iamv1.ListBindingsRequest{Filter: &iamv1.ListBindingsRequest_Resource{Resource: &iamv1.ResourceRef{Type: iamv1.ResourceType_RESOURCE_TYPE_ORG, Id: org.ID, OrgId: org.ID}}})
	if err != nil {
		return UserRef{}, iamError(err)
	}
	for _, b := range resp.GetBindings() {
		if b.GetRole() == iamv1.Role_ROLE_OWNER && b.GetResource().GetId() == org.ID && b.GetPrincipalName() != "" {
			return UserRef{ID: b.GetPrincipal().GetId(), Username: b.GetPrincipalName()}, nil
		}
	}
	names, err := s.lookupUsers(ctx, []string{org.CreatedBy})
	if err != nil {
		return UserRef{}, err
	}
	return userRef(org.CreatedBy, names), nil
}

func (s *Service) orgView(ctx context.Context, org store.Org, role authz.Role) (OrgView, error) {
	owner, err := s.ownerRef(ctx, org)
	if err != nil {
		return OrgView{}, err
	}
	return OrgView{ID: org.ID, Name: org.Name, Owner: owner, MyRole: rolePtr(role), CreatedAt: utc(org.CreatedAt), UpdatedAt: utc(org.UpdatedAt)}, nil
}

func (s *Service) CreateOrg(ctx context.Context, p authz.Principal, name string) (OrgView, error) {
	if err := requireUser(p, "service accounts cannot create organizations"); err != nil {
		return OrgView{}, err
	}
	if !ValidOrgName(name) {
		return OrgView{}, invalid("name", "must be 3-63 lower-case letters, digits and hyphens, starting with a letter or digit")
	}
	var org store.Org
	var ids []string
	err := s.store.InTx(ctx, func(q *store.Q) error {
		if err := q.LockUserOrgQuota(ctx, p.ID); err != nil {
			return err
		}
		if n, err := q.CountOrgsCreatedBy(ctx, p.ID); err != nil {
			return err
		} else if n >= s.limits.MaxOrgsPerUser {
			return quotaExceeded("name", "organizations per user", s.limits.MaxOrgsPerUser)
		}
		var err error
		org, err = q.InsertOrg(ctx, store.Org{ID: newID(), Name: name, CreatedBy: p.ID})
		if err != nil {
			return err
		}
		kind, pl := outbox.CreateOrgOwner(org.ID, p.ID)
		id, err := outbox.Enqueue(ctx, q, kind, pl)
		ids = append(ids, id)
		return err
	})
	if err != nil {
		return OrgView{}, dbError(err)
	}
	s.afterCommit(ctx, ids)
	s.authz.Invalidate(p)
	names, err := s.lookupUsers(ctx, []string{p.ID})
	if err != nil {
		names = map[string]string{}
	}
	return OrgView{ID: org.ID, Name: org.Name, Owner: userRef(p.ID, names), MyRole: rolePtr(authz.RoleOwner), CreatedAt: utc(org.CreatedAt), UpdatedAt: utc(org.UpdatedAt)}, nil
}

func (s *Service) ListOrgs(ctx context.Context, p authz.Principal, pr PageReq) (Page[OrgView], error) {
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return Page[OrgView]{}, err
	}
	members, err := s.memberOrgs(ctx, bs)
	if err != nil {
		return Page[OrgView]{}, err
	}
	ids := make([]string, 0, len(members))
	for id := range members {
		ids = append(ids, id)
	}
	orgs, total, err := s.store.Q().ListOrgs(ctx, ids, pr.Limit, pr.Offset)
	if err != nil {
		return Page[OrgView]{}, dbError(err)
	}
	items := make([]OrgView, 0, len(orgs))
	for _, org := range orgs {
		v, err := s.orgView(ctx, org, authz.OrgRole(bs, org.ID))
		if err != nil {
			return Page[OrgView]{}, err
		}
		items = append(items, v)
	}
	return newPage(items, total, pr), nil
}

func (s *Service) GetOrg(ctx context.Context, p authz.Principal, id string) (OrgView, error) {
	org, err := s.store.Q().GetOrg(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return OrgView{}, notFound("organization")
	}
	if err != nil {
		return OrgView{}, dbError(err)
	}
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return OrgView{}, err
	}
	members, err := s.memberOrgs(ctx, bs)
	if err != nil {
		return OrgView{}, err
	}
	if !members[org.ID] {
		return OrgView{}, notFound("organization")
	}
	return s.orgView(ctx, org, authz.OrgRole(bs, org.ID))
}

func (s *Service) RenameOrg(ctx context.Context, p authz.Principal, id, name string) (OrgView, error) {
	_, role, _, err := s.requireOrg(ctx, p, id, authz.ActionManageAccess)
	if err != nil {
		return OrgView{}, err
	}
	if !ValidOrgName(name) {
		return OrgView{}, invalid("name", "must be 3-63 lower-case letters, digits and hyphens, starting with a letter or digit")
	}
	org, err := s.store.Q().RenameOrg(ctx, id, name)
	if errors.Is(err, store.ErrNotFound) {
		return OrgView{}, notFound("organization")
	}
	if err != nil {
		return OrgView{}, dbError(err)
	}
	return s.orgView(ctx, org, role)
}

func (s *Service) DeleteOrg(ctx context.Context, p authz.Principal, id string) error {
	if _, _, _, err := s.requireOrg(ctx, p, id, authz.ActionOwn); err != nil {
		return err
	}
	var ids []string
	err := s.store.InTx(ctx, func(q *store.Q) error {
		org, err := q.LockOrg(ctx, id)
		if err != nil {
			return err
		}
		n, err := q.CountZonesInOrg(ctx, org.ID)
		if err != nil {
			return err
		}
		if n > 0 {
			return conflict("the organization still contains zones")
		}
		if err := q.DeleteOrg(ctx, org.ID); err != nil {
			return err
		}
		if err := q.InsertTombstone(ctx, "org", org.ID, org.ID, s.now()); err != nil {
			return err
		}
		kind, pl := outbox.RevokeResource(iamv1.ResourceType_RESOURCE_TYPE_ORG, org.ID, org.ID)
		oid, err := outbox.Enqueue(ctx, q, kind, pl)
		ids = append(ids, oid)
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return notFound("organization")
	}
	if errors.Is(err, store.ErrConflict) {
		return conflict("the organization still contains zones")
	}
	if err != nil {
		return dbError(err)
	}
	s.afterCommit(ctx, ids)
	s.authz.Invalidate(p)
	return nil
}

type orgBindingSet struct {
	principalType iamv1.PrincipalType
	principalID   string
	name          string
	orgRole       authz.Role
}

func (s *Service) orgMembers(ctx context.Context, orgID string) ([]*orgBindingSet, error) {
	resp, err := s.iam.ListBindings(ctx, &iamv1.ListBindingsRequest{Filter: &iamv1.ListBindingsRequest_OrgId{OrgId: orgID}})
	if err != nil {
		return nil, iamError(err)
	}
	var zoneIDs []string
	for _, b := range resp.GetBindings() {
		if b.GetResource().GetType() == iamv1.ResourceType_RESOURCE_TYPE_ZONE {
			zoneIDs = append(zoneIDs, b.GetResource().GetId())
		}
	}
	zoneOrgs := map[string]string{}
	if len(zoneIDs) > 0 {
		if zoneOrgs, err = s.store.Q().ZoneOrgs(ctx, zoneIDs); err != nil {
			return nil, dbError(err)
		}
	}
	byKey := map[string]*orgBindingSet{}
	var out []*orgBindingSet
	for _, b := range resp.GetBindings() {
		r := b.GetResource()
		if r.GetOrgId() != orgID {
			continue
		}
		if r.GetType() == iamv1.ResourceType_RESOURCE_TYPE_ZONE && zoneOrgs[r.GetId()] != orgID {
			continue
		}
		k := b.GetPrincipal().GetType().String() + ":" + b.GetPrincipal().GetId()
		m, ok := byKey[k]
		if !ok {
			m = &orgBindingSet{principalType: b.GetPrincipal().GetType(), principalID: b.GetPrincipal().GetId(), name: b.GetPrincipalName()}
			byKey[k] = m
			out = append(out, m)
		}
		if m.name == "" {
			m.name = b.GetPrincipalName()
		}
		if r.GetType() == iamv1.ResourceType_RESOURCE_TYPE_ORG && r.GetId() == orgID && authz.Role(b.GetRole()) > m.orgRole {
			m.orgRole = authz.Role(b.GetRole())
		}
	}
	return out, nil
}

func principalTypeName(t iamv1.PrincipalType) string {
	if t == iamv1.PrincipalType_PRINCIPAL_TYPE_SERVICE_ACCOUNT {
		return "service_account"
	}
	return "user"
}

func (s *Service) ListMembers(ctx context.Context, p authz.Principal, orgID string, pr PageReq) (Page[MemberView], error) {
	if _, _, _, err := s.requireOrg(ctx, p, orgID, authz.ActionRead); err != nil {
		return Page[MemberView]{}, err
	}
	members, err := s.orgMembers(ctx, orgID)
	if err != nil {
		return Page[MemberView]{}, err
	}
	all := make([]MemberView, 0, len(members))
	for _, m := range members {
		name := m.name
		if name == "" {
			name = unknownUsername
		}
		all = append(all, MemberView{PrincipalType: principalTypeName(m.principalType), PrincipalID: m.principalID, Name: name, OrgRole: rolePtr(m.orgRole)})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Name != all[j].Name {
			return all[i].Name < all[j].Name
		}
		return all[i].PrincipalID < all[j].PrincipalID
	})
	return paginate(all, pr), nil
}

func findMember(members []*orgBindingSet, ptype iamv1.PrincipalType, id string) *orgBindingSet {
	for _, m := range members {
		if m.principalType == ptype && m.principalID == id {
			return m
		}
	}
	return nil
}

func (s *Service) RemoveMember(ctx context.Context, p authz.Principal, orgID, userID string) error {
	self := p.IsUser() && p.ID == userID
	action := authz.ActionManageAccess
	if self {
		action = authz.ActionRead
	}
	_, _, _, err := s.requireOrg(ctx, p, orgID, action)
	if err != nil && (!self || !isForbidden(err)) {
		return err
	}
	members, err := s.orgMembers(ctx, orgID)
	if err != nil {
		return err
	}
	target := findMember(members, iamv1.PrincipalType_PRINCIPAL_TYPE_USER, userID)
	if target == nil {
		return notFound("member")
	}
	if target.orgRole == authz.RoleOwner {
		return forbidden("the owner cannot be removed; transfer ownership first")
	}
	_, err = s.iam.Revoke(ctx, &iamv1.RevokeRequest{Target: &iamv1.RevokeRequest_PrincipalInOrg{PrincipalInOrg: &iamv1.PrincipalInOrg{
		Principal: &iamv1.Principal{Type: iamv1.PrincipalType_PRINCIPAL_TYPE_USER, Id: userID}, OrgId: orgID,
	}}})
	if status.Code(err) == codes.FailedPrecondition {
		return forbidden("the owner cannot be removed; transfer ownership first")
	}
	if err != nil {
		return iamError(err)
	}
	s.authz.Invalidate(authz.Principal{Type: iamv1.PrincipalType_PRINCIPAL_TYPE_USER, ID: userID})
	return nil
}

func (s *Service) TransferOwnership(ctx context.Context, p authz.Principal, orgID, userID string) (OrgView, error) {
	org, _, _, err := s.requireOrg(ctx, p, orgID, authz.ActionOwn)
	if err != nil {
		return OrgView{}, err
	}
	if !ValidUUID(userID) {
		return OrgView{}, invalid("user_id", "must be a UUID")
	}
	if userID == p.ID {
		return OrgView{}, invalid("user_id", "you already own the organization")
	}
	members, err := s.orgMembers(ctx, orgID)
	if err != nil {
		return OrgView{}, err
	}
	if findMember(members, iamv1.PrincipalType_PRINCIPAL_TYPE_USER, userID) == nil {
		return OrgView{}, invalid("user_id", "the new owner must be a user member of the organization")
	}
	_, err = s.iam.TransferOwnership(ctx, &iamv1.TransferOwnershipRequest{OrgId: orgID, FromUserId: p.ID, ToUserId: userID})
	if status.Code(err) == codes.FailedPrecondition {
		return OrgView{}, forbidden("only the current owner can transfer ownership")
	}
	if status.Code(err) == codes.InvalidArgument {
		return OrgView{}, invalid("user_id", "the new owner must be a user member of the organization")
	}
	if err != nil {
		return OrgView{}, iamError(err)
	}
	s.authz.Invalidate(p)
	s.authz.Invalidate(authz.Principal{Type: iamv1.PrincipalType_PRINCIPAL_TYPE_USER, ID: userID})
	return s.orgView(ctx, org, authz.RoleAdmin)
}
