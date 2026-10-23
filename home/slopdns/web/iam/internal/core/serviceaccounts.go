package core

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/store"
	"slopdns/web/pkg/rbac"
)

type ServiceAccountView struct {
	store.ServiceAccount
	CreatedByUsername string
	MyRole            rbac.Role
}

func checkSAName(name string) error {
	if !ValidServiceAccountName(name) {
		return invalid("name", "must be 3-63 characters of a-z, 0-9 and '-', starting with a letter or digit")
	}
	return nil
}

func checkDescription(d string) error {
	if !ValidDescription(d) {
		return invalid("description", "must be at most 256 characters without control characters")
	}
	return nil
}

func saViews(ctx context.Context, tx store.Tx, sas []store.ServiceAccount, roles map[uuid.UUID]rbac.Role) ([]ServiceAccountView, error) {
	ids := make([]uuid.UUID, 0, len(sas))
	for _, sa := range sas {
		ids = append(ids, sa.CreatedBy)
	}
	users, err := tx.UsersByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	names := map[uuid.UUID]string{}
	for _, u := range users {
		names[u.ID] = u.Username
	}
	out := make([]ServiceAccountView, 0, len(sas))
	for _, sa := range sas {
		out = append(out, ServiceAccountView{ServiceAccount: sa, CreatedByUsername: names[sa.CreatedBy], MyRole: roles[sa.ID]})
	}
	return out, nil
}

func (s *Service) CreateServiceAccount(ctx context.Context, c Caller, orgID uuid.UUID, name, description string) (ServiceAccountView, error) {
	if err := requireUser(c); err != nil {
		return ServiceAccountView{}, err
	}
	if err := checkSAName(name); err != nil {
		return ServiceAccountView{}, err
	}
	if err := checkDescription(description); err != nil {
		return ServiceAccountView{}, err
	}
	orgRes := toResource(rbac.ResourceOrg, orgID, orgID)
	if err := s.inTx(ctx, func(tx store.Tx) error {
		_, err := s.authorize(ctx, tx, c, orgRes, rbac.ActionWrite, "organization")
		return err
	}); err != nil {
		return ServiceAccountView{}, err
	}
	if _, err := s.resourceOrg(ctx, rbac.ResourceOrg, orgID); err != nil {
		if KindOf(err) == KindNotFound {
			return ServiceAccountView{}, notFound("organization not found")
		}
		return ServiceAccountView{}, err
	}
	id, err := newID()
	if err != nil {
		return ServiceAccountView{}, internal(err)
	}
	now := s.clock()
	sa := store.ServiceAccount{ID: id, OrgID: orgID, Name: name, Description: description, CreatedBy: c.ID, CreatedAt: now, UpdatedAt: now}
	var out ServiceAccountView
	err = s.inTx(ctx, func(tx store.Tx) error {
		d, err := s.authorize(ctx, tx, c, orgRes, rbac.ActionWrite, "organization")
		if err != nil {
			return err
		}
		if err := tx.CreateServiceAccount(ctx, sa); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return conflict("a service account with this name already exists in the organization")
			}
			return err
		}
		vs, err := saViews(ctx, tx, []store.ServiceAccount{sa}, map[uuid.UUID]rbac.Role{sa.ID: d.Effective})
		if err != nil {
			return err
		}
		out = vs[0]
		return nil
	})
	return out, err
}

func (s *Service) GetServiceAccount(ctx context.Context, c Caller, id uuid.UUID) (ServiceAccountView, error) {
	var out ServiceAccountView
	err := s.inTx(ctx, func(tx store.Tx) error {
		sa, res, err := s.saResource(ctx, tx, id)
		if err != nil {
			return err
		}
		d, err := s.authorize(ctx, tx, c, res, rbac.ActionRead, "service account")
		if err != nil {
			return err
		}
		vs, err := saViews(ctx, tx, []store.ServiceAccount{sa}, map[uuid.UUID]rbac.Role{sa.ID: d.Effective})
		if err != nil {
			return err
		}
		out = vs[0]
		return nil
	})
	return out, err
}

func (s *Service) ListServiceAccounts(ctx context.Context, c Caller, orgID uuid.UUID, p Page) ([]ServiceAccountView, int, error) {
	var out []ServiceAccountView
	var total int
	err := s.inTx(ctx, func(tx store.Tx) error {
		if c.Type == rbac.PrincipalServiceAccount && c.OrgID != orgID {
			return notFound("organization not found")
		}
		bs, err := principalBindings(ctx, tx, c.Principal())
		if err != nil {
			return err
		}
		rb := rbacBindings(bs)
		orgStr := orgID.String()
		if !rbac.Member(orgStr, rb) {
			return notFound("organization not found")
		}
		orgRole, _ := rbac.Roles(toResource(rbac.ResourceOrg, orgID, orgID), rb)
		var only []uuid.UUID
		roles := map[uuid.UUID]rbac.Role{}
		if orgRole < rbac.RoleReader {
			only = []uuid.UUID{}
			for _, b := range bs {
				if b.ResourceType == rbac.ResourceServiceAccount && b.OrgID == orgID && b.Role >= rbac.RoleReader {
					only = append(only, b.ResourceID)
				}
			}
		}
		sas, n, err := tx.ListServiceAccounts(ctx, orgID, only, p.store())
		if err != nil {
			return err
		}
		for _, sa := range sas {
			roles[sa.ID] = rbac.EffectiveRole(toResource(rbac.ResourceServiceAccount, sa.ID, sa.OrgID), rb)
		}
		out, err = saViews(ctx, tx, sas, roles)
		total = n
		return err
	})
	return out, total, err
}

type ServiceAccountUpdate struct {
	Name        *string
	Description *string
}

func (s *Service) UpdateServiceAccount(ctx context.Context, c Caller, id uuid.UUID, upd ServiceAccountUpdate) (ServiceAccountView, error) {
	if upd.Name == nil && upd.Description == nil {
		return ServiceAccountView{}, invalid("name", "at least one of name and description is required")
	}
	if upd.Name != nil {
		if err := checkSAName(*upd.Name); err != nil {
			return ServiceAccountView{}, err
		}
	}
	if upd.Description != nil {
		if err := checkDescription(*upd.Description); err != nil {
			return ServiceAccountView{}, err
		}
	}
	var out ServiceAccountView
	err := s.inTx(ctx, func(tx store.Tx) error {
		sa, res, err := s.saResource(ctx, tx, id)
		if err != nil {
			return err
		}
		d, err := s.authorize(ctx, tx, c, res, rbac.ActionWrite, "service account")
		if err != nil {
			return err
		}
		if upd.Name != nil {
			sa.Name = *upd.Name
		}
		if upd.Description != nil {
			sa.Description = *upd.Description
		}
		sa.UpdatedAt = s.clock()
		if err := tx.UpdateServiceAccount(ctx, sa); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return conflict("a service account with this name already exists in the organization")
			}
			return err
		}
		vs, err := saViews(ctx, tx, []store.ServiceAccount{sa}, map[uuid.UUID]rbac.Role{sa.ID: d.Effective})
		if err != nil {
			return err
		}
		out = vs[0]
		return nil
	})
	return out, err
}

func deleteServiceAccount(ctx context.Context, tx store.Tx, sa store.ServiceAccount) (int, error) {
	asPrincipal := store.Principal{Type: rbac.PrincipalServiceAccount, ID: sa.ID}
	own, _, err := tx.ListBindings(ctx, store.BindingFilter{Principal: &asPrincipal}, store.Page{})
	if err != nil {
		return 0, err
	}
	saID := sa.ID
	onSA, _, err := tx.ListBindings(ctx, store.BindingFilter{ResourceType: rbac.ResourceServiceAccount, ResourceID: &saID}, store.Page{})
	if err != nil {
		return 0, err
	}
	deleted, err := deleteAndBump(ctx, tx, append(own, onSA...), asPrincipal)
	if err != nil {
		return 0, err
	}
	if err := tx.DeleteAPITokensByOwner(ctx, store.OwnerServiceAccount, sa.ID); err != nil {
		return 0, err
	}
	if err := tx.DeleteServiceAccount(ctx, sa.ID); err != nil {
		return 0, err
	}
	return len(deleted), nil
}

func (s *Service) DeleteServiceAccount(ctx context.Context, c Caller, id uuid.UUID) error {
	return s.inTx(ctx, func(tx store.Tx) error {
		sa, res, err := s.saResource(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, "service account"); err != nil {
			return err
		}
		_, err = deleteServiceAccount(ctx, tx, sa)
		return err
	})
}
