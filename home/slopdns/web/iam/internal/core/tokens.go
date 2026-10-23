package core

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/token"
	"slopdns/web/pkg/rbac"
)

type CreatedToken struct {
	store.APIToken
	Token string
}

type TokenRequest struct {
	Name          string
	ExpiresInDays *int
	NoExpiry      bool
	TOTPCode      *string
}

func checkTokenName(name string) error {
	if !ValidTokenName(name) {
		return invalid("name", "must be 1-64 characters from [A-Za-z0-9 ._:@-]")
	}
	return nil
}

func (s *Service) ListMyTokens(ctx context.Context, c Caller, p Page) ([]store.APIToken, int, error) {
	if err := requireUser(c); err != nil {
		return nil, 0, err
	}
	var out []store.APIToken
	var total int
	err := s.inTx(ctx, func(tx store.Tx) error {
		var err error
		out, total, err = tx.ListAPITokens(ctx, store.OwnerUser, c.ID, p.store())
		return err
	})
	return out, total, err
}

func (s *Service) CreateMyToken(ctx context.Context, c Caller, req TokenRequest) (CreatedToken, error) {
	if err := requireSession(c); err != nil {
		return CreatedToken{}, err
	}
	if err := checkTokenName(req.Name); err != nil {
		return CreatedToken{}, err
	}
	days := s.cfg.DefaultTokenDays
	if req.ExpiresInDays != nil {
		days = *req.ExpiresInDays
		if days < MinTokenDays || days > MaxTokenDays {
			return CreatedToken{}, invalid("expires_in_days", "must be between 1 and 3650")
		}
	}
	if req.TOTPCode != nil {
		if err := checkTOTPCode("totp_code", *req.TOTPCode); err != nil {
			return CreatedToken{}, err
		}
	}
	tok, err := token.New(token.KindUserAPI)
	if err != nil {
		return CreatedToken{}, internal(err)
	}
	now := s.clock()
	row := store.APIToken{ID: tok.ID, OwnerType: store.OwnerUser, OwnerID: c.ID, Name: req.Name, SecretHash: tok.Hash(), CreatedBy: c.ID, CreatedAt: now}
	if !req.NoExpiry {
		exp := now.Add(time.Duration(days) * 24 * time.Hour)
		row.ExpiresAt = &exp
	}
	var u store.User
	if err := s.inTx(ctx, func(tx store.Tx) error {
		var err error
		u, err = tx.UserByID(ctx, c.ID)
		return err
	}); err != nil {
		return CreatedToken{}, err
	}
	reserved := 0
	if u.TOTPEnabled {
		if req.TOTPCode == nil {
			return CreatedToken{}, mfaInvalid()
		}
		if err := s.inTx(ctx, func(tx store.Tx) error {
			var err error
			reserved, err = tx.ReserveSessionTOTPAttempt(ctx, *c.SessionID)
			return err
		}); err != nil {
			return CreatedToken{}, err
		}
		if reserved == 0 {
			return CreatedToken{}, &Error{Kind: KindUnauthenticated, Message: "session is no longer valid, log in again"}
		}
	}
	err = s.inTx(ctx, func(tx store.Tx) error {
		u, err := tx.LockUser(ctx, c.ID)
		if err != nil {
			return err
		}
		if u.TOTPEnabled {
			if req.TOTPCode == nil || reserved == 0 {
				return mfaInvalid()
			}
			if err := s.verifyTOTP(ctx, tx, u, *req.TOTPCode, now); err != nil {
				return err
			}
		}
		if reserved > 0 {
			if err := tx.RefundSessionTOTPAttempt(ctx, *c.SessionID); err != nil {
				return err
			}
		}
		return tx.CreateAPIToken(ctx, row)
	})
	if errors.Is(err, errVerification) {
		if reserved >= store.MaxSessionTOTPFailures {
			if rerr := s.inTx(ctx, func(tx store.Tx) error { return tx.RevokeSession(ctx, *c.SessionID, s.clock()) }); rerr != nil {
				return CreatedToken{}, rerr
			}
		}
		return CreatedToken{}, mfaInvalid()
	}
	if err != nil {
		return CreatedToken{}, err
	}
	return CreatedToken{APIToken: row, Token: tok.String()}, nil
}

func (s *Service) RevokeMyToken(ctx context.Context, c Caller, tokenID uuid.UUID) error {
	if err := requireUser(c); err != nil {
		return err
	}
	now := s.clock()
	return s.inTx(ctx, func(tx store.Tx) error {
		ok, err := tx.RevokeAPIToken(ctx, tokenID, store.OwnerUser, c.ID, now)
		if err != nil {
			return err
		}
		if !ok {
			return notFound("token not found")
		}
		return nil
	})
}

func (s *Service) saResource(ctx context.Context, tx store.Tx, id uuid.UUID) (store.ServiceAccount, rbac.Resource, error) {
	sa, err := tx.ServiceAccountByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return sa, rbac.Resource{}, notFound("service account not found")
	}
	if err != nil {
		return sa, rbac.Resource{}, err
	}
	return sa, toResource(rbac.ResourceServiceAccount, sa.ID, sa.OrgID), nil
}

func (s *Service) ListServiceAccountTokens(ctx context.Context, c Caller, saID uuid.UUID, p Page) ([]store.APIToken, int, error) {
	var out []store.APIToken
	var total int
	err := s.inTx(ctx, func(tx store.Tx) error {
		_, res, err := s.saResource(ctx, tx, saID)
		if err != nil {
			return err
		}
		if _, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, "service account"); err != nil {
			return err
		}
		out, total, err = tx.ListAPITokens(ctx, store.OwnerServiceAccount, saID, p.store())
		return err
	})
	return out, total, err
}

func (s *Service) CreateServiceAccountToken(ctx context.Context, c Caller, saID uuid.UUID, name string) (CreatedToken, error) {
	if err := checkTokenName(name); err != nil {
		return CreatedToken{}, err
	}
	tok, err := token.New(token.KindServiceAccount)
	if err != nil {
		return CreatedToken{}, internal(err)
	}
	now := s.clock()
	row := store.APIToken{ID: tok.ID, OwnerType: store.OwnerServiceAccount, OwnerID: saID, Name: name, SecretHash: tok.Hash(), CreatedBy: c.ID, CreatedAt: now}
	err = s.inTx(ctx, func(tx store.Tx) error {
		_, res, err := s.saResource(ctx, tx, saID)
		if err != nil {
			return err
		}
		if _, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, "service account"); err != nil {
			return err
		}
		return tx.CreateAPIToken(ctx, row)
	})
	if err != nil {
		return CreatedToken{}, err
	}
	return CreatedToken{APIToken: row, Token: tok.String()}, nil
}

func (s *Service) RevokeServiceAccountToken(ctx context.Context, c Caller, saID, tokenID uuid.UUID) error {
	now := s.clock()
	return s.inTx(ctx, func(tx store.Tx) error {
		_, res, err := s.saResource(ctx, tx, saID)
		if err != nil {
			return err
		}
		if _, err := s.authorize(ctx, tx, c, res, rbac.ActionManageAccess, "service account"); err != nil {
			return err
		}
		ok, err := tx.RevokeAPIToken(ctx, tokenID, store.OwnerServiceAccount, saID, now)
		if err != nil {
			return err
		}
		if !ok {
			return notFound("token not found")
		}
		return nil
	})
}
