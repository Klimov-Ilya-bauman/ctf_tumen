package core

import (
	"context"
	"errors"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/outbox"
	"slopdns/web/backend/internal/store"
	"slopdns/web/pkg/rbac"
)

var transferStatuses = map[string]bool{store.StatusPending: true, store.StatusAccepted: true, store.StatusDeclined: true, store.StatusCancelled: true, store.StatusExpired: true}

func ValidTransferStatus(s string) bool {
	return s == "" || transferStatuses[s]
}

func (s *Service) transferViews(ctx context.Context, list []store.Transfer) ([]TransferView, error) {
	var ids []string
	for _, t := range list {
		ids = append(ids, t.FromUserID, t.ToUserID)
	}
	names, err := s.lookupUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]TransferView, 0, len(list))
	for _, t := range list {
		out = append(out, transferView(t, names))
	}
	return out, nil
}

func (s *Service) transferView(ctx context.Context, t store.Transfer) (TransferView, error) {
	views, err := s.transferViews(ctx, []store.Transfer{t})
	if err != nil {
		return TransferView{}, err
	}
	return views[0], nil
}

func (s *Service) CreateTransfer(ctx context.Context, p authz.Principal, zoneID, username string) (TransferView, error) {
	_, _, bs, err := s.requireZone(ctx, p, zoneID, authz.ActionManageAccess)
	if err != nil {
		return TransferView{}, err
	}
	if err := requireUser(p, "service accounts cannot transfer zones"); err != nil {
		return TransferView{}, err
	}
	if !ValidUsername(username) {
		return TransferView{}, invalid("username", "must be a valid username")
	}
	toID, found, err := s.userByName(ctx, username)
	if err != nil {
		return TransferView{}, err
	}
	if !found {
		return TransferView{}, invalid("username", "user not found")
	}
	if toID == p.ID {
		return TransferView{}, invalid("username", "you cannot transfer a zone to yourself")
	}
	if err := s.expireLazily(ctx); err != nil {
		return TransferView{}, err
	}
	var out store.Transfer
	err = s.store.InTx(ctx, func(q *store.Q) error {
		z, err := s.lockZoneFor(ctx, q, bs, zoneID, authz.ActionManageAccess)
		if err != nil {
			return err
		}
		now := s.now()
		out, err = q.InsertTransfer(ctx, store.Transfer{ID: newID(), ZoneID: z.ID, ZoneName: z.Name, FromOrgID: z.OrgID, FromUserID: p.ID, ToUserID: toID, CreatedAt: now, ExpiresAt: now.Add(TransferTTL)})
		return err
	})
	if store.IsUnique(err, store.TransfersPendingKey) {
		return TransferView{}, conflict("the zone already has a pending transfer")
	}
	if errors.Is(err, store.ErrNotFound) {
		return TransferView{}, notFound("zone")
	}
	if err != nil {
		return TransferView{}, dbError(err)
	}
	return s.transferView(ctx, out)
}

func (s *Service) adminScopes(ctx context.Context, bs []authz.Binding) ([]string, []string, error) {
	var orgs []string
	for _, b := range authz.OrgBindings(bs) {
		if b.Role >= authz.RoleAdmin {
			orgs = append(orgs, b.OrgID)
		}
	}
	zoneRoles, err := s.validZoneRoles(ctx, bs)
	if err != nil {
		return nil, nil, err
	}
	var zones []string
	for id, b := range zoneRoles {
		if b.Role >= authz.RoleAdmin {
			zones = append(zones, id)
		}
	}
	return orgs, zones, nil
}

func (s *Service) ListTransfers(ctx context.Context, p authz.Principal, direction, status string, pr PageReq) (Page[TransferView], error) {
	if err := s.expireLazily(ctx); err != nil {
		return Page[TransferView]{}, err
	}
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return Page[TransferView]{}, err
	}
	orgs, zones, err := s.adminScopes(ctx, bs)
	if err != nil {
		return Page[TransferView]{}, err
	}
	f := store.TransferFilter{Incoming: direction != "outgoing" && p.IsUser(), Outgoing: direction != "incoming", UserID: p.ID, AdminOrgs: orgs, AdminZones: zones, Status: status}
	list, total, err := s.store.Q().ListTransfers(ctx, f, pr.Limit, pr.Offset)
	if err != nil {
		return Page[TransferView]{}, dbError(err)
	}
	views, err := s.transferViews(ctx, list)
	if err != nil {
		return Page[TransferView]{}, err
	}
	return newPage(views, total, pr), nil
}

type transferAccess struct {
	recipient bool
	zoneAdmin bool
}

func (s *Service) loadTransfer(ctx context.Context, p authz.Principal, id string) (store.Transfer, transferAccess, []authz.Binding, error) {
	if err := s.expireLazily(ctx); err != nil {
		return store.Transfer{}, transferAccess{}, nil, err
	}
	t, err := s.store.Q().GetTransfer(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return store.Transfer{}, transferAccess{}, nil, notFound("zone transfer")
	}
	if err != nil {
		return store.Transfer{}, transferAccess{}, nil, dbError(err)
	}
	bs, err := s.bindings(ctx, p)
	if err != nil {
		return store.Transfer{}, transferAccess{}, nil, err
	}
	var acc transferAccess
	acc.recipient = p.IsUser() && t.ToUserID == p.ID
	if z, err := s.store.Q().GetZone(ctx, t.ZoneID); err == nil {
		acc.zoneAdmin = authz.ZoneRole(bs, z.ID, z.OrgID) >= authz.RoleAdmin
	} else if !errors.Is(err, store.ErrNotFound) {
		return store.Transfer{}, transferAccess{}, nil, dbError(err)
	}
	initiator := p.IsUser() && t.FromUserID == p.ID
	fromAdmin := authz.OrgRole(bs, t.FromOrgID) >= authz.RoleAdmin
	if !acc.recipient && !acc.zoneAdmin && !initiator && !fromAdmin {
		return store.Transfer{}, transferAccess{}, nil, notFound("zone transfer")
	}
	return t, acc, bs, nil
}

func (s *Service) GetTransfer(ctx context.Context, p authz.Principal, id string) (TransferView, error) {
	t, _, _, err := s.loadTransfer(ctx, p, id)
	if err != nil {
		return TransferView{}, err
	}
	return s.transferView(ctx, t)
}

func pendingConflict(t store.Transfer) error {
	return conflict("the zone transfer is " + t.Status)
}

func highestOwnedOrg(bs []authz.Binding) string {
	best := ""
	var bestRole authz.Role
	for _, b := range bs {
		if b.ResourceType != rbac.ResourceOrg || b.ResourceID != b.OrgID {
			continue
		}
		if b.Role >= authz.RoleAdmin && b.Role > bestRole {
			best, bestRole = b.OrgID, b.Role
		}
	}
	return best
}

func (s *Service) AcceptTransfer(ctx context.Context, p authz.Principal, id, targetOrgID string) (TransferView, error) {
	t, acc, bs, err := s.loadTransfer(ctx, p, id)
	if err != nil {
		return TransferView{}, err
	}
	if !acc.recipient {
		return TransferView{}, forbidden("only the recipient can accept the zone transfer")
	}
	if !ValidUUID(targetOrgID) {
		return TransferView{}, invalid("target_org_id", "must be a UUID")
	}
	if authz.OrgRole(bs, highestOwnedOrg(bs)) < authz.RoleAdmin {
		return TransferView{}, forbidden("you must be owner or admin of the target organization")
	}
	if exists, err := s.store.Q().OrgExists(ctx, targetOrgID); err != nil {
		return TransferView{}, dbError(err)
	} else if !exists {
		return TransferView{}, forbidden("you must be owner or admin of the target organization")
	}
	var out store.Transfer
	var ids []string
	err = s.store.InTx(ctx, func(q *store.Q) error {
		if err := q.LockZoneTree(ctx); err != nil {
			return err
		}
		z, err := q.LockZone(ctx, t.ZoneID)
		if errors.Is(err, store.ErrNotFound) {
			cur, gerr := q.GetTransfer(ctx, t.ID)
			if gerr != nil {
				return gerr
			}
			return pendingConflict(cur)
		}
		if err != nil {
			return err
		}
		cur, err := q.LockTransfer(ctx, t.ID)
		if err != nil {
			return err
		}
		if cur.Status != store.StatusPending {
			return pendingConflict(cur)
		}
		if !cur.ExpiresAt.After(s.now()) {
			return conflict("the zone transfer has expired")
		}
		if z.OrgID == targetOrgID {
			return invalid("target_org_id", "the zone already belongs to this organization")
		}
		if err := s.checkNesting(ctx, q, z.Name, targetOrgID, z.ID); err != nil {
			return err
		}
		if err := s.checkZoneQuota(ctx, q, targetOrgID, "target_org_id"); err != nil {
			return err
		}
		if err := q.MoveZone(ctx, z.ID, targetOrgID); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return forbidden("you must be owner or admin of the target organization")
			}
			return err
		}
		target := targetOrgID
		if out, err = q.DecideTransfer(ctx, cur.ID, store.StatusAccepted, &target, s.now()); err != nil {
			return err
		}
		kind, pl := outbox.ZoneTransfer(z.ID, z.OrgID, targetOrgID, p.ID)
		oid, err := outbox.Enqueue(ctx, q, kind, pl)
		if err != nil {
			return err
		}
		ids = append(ids, oid)
		_, err = q.AppendChange(ctx, z.ID, nil)
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return TransferView{}, notFound("zone transfer")
	}
	if err != nil {
		return TransferView{}, dbError(err)
	}
	s.afterCommit(ctx, ids)
	s.authz.Invalidate(p)
	return s.transferView(ctx, out)
}

func (s *Service) decideTransfer(ctx context.Context, t store.Transfer, status string) (TransferView, error) {
	var out store.Transfer
	err := s.store.InTx(ctx, func(q *store.Q) error {
		cur, err := q.LockTransfer(ctx, t.ID)
		if err != nil {
			return err
		}
		if cur.Status != store.StatusPending {
			return pendingConflict(cur)
		}
		if !cur.ExpiresAt.After(s.now()) {
			return conflict("the zone transfer has expired")
		}
		out, err = q.DecideTransfer(ctx, cur.ID, status, nil, s.now())
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return TransferView{}, notFound("zone transfer")
	}
	if err != nil {
		return TransferView{}, dbError(err)
	}
	return s.transferView(ctx, out)
}

func (s *Service) DeclineTransfer(ctx context.Context, p authz.Principal, id string) (TransferView, error) {
	t, acc, _, err := s.loadTransfer(ctx, p, id)
	if err != nil {
		return TransferView{}, err
	}
	if !acc.recipient {
		return TransferView{}, forbidden("only the recipient can decline the zone transfer")
	}
	return s.decideTransfer(ctx, t, store.StatusDeclined)
}

func (s *Service) CancelTransfer(ctx context.Context, p authz.Principal, id string) (TransferView, error) {
	t, acc, _, err := s.loadTransfer(ctx, p, id)
	if err != nil {
		return TransferView{}, err
	}
	if !acc.zoneAdmin {
		if t.Status != store.StatusPending {
			return TransferView{}, pendingConflict(t)
		}
		return TransferView{}, forbidden("admin role on the zone is required")
	}
	return s.decideTransfer(ctx, t, store.StatusCancelled)
}
