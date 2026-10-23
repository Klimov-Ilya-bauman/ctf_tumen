package core

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/token"
	"slopdns/web/iam/internal/totp"
	"slopdns/web/pkg/rbac"
)

type LoginResult struct {
	User           store.User
	MFARequired    bool
	MFAToken       string
	MFAExpiresAt   time.Time
	SessionToken   string
	SessionExpires time.Time
	SessionMaxAge  time.Duration
}

func (s *Service) Register(ctx context.Context, username, pw string) (store.User, error) {
	if err := checkUsername("username", username); err != nil {
		return store.User{}, err
	}
	if err := checkPassword("password", pw); err != nil {
		return store.User{}, err
	}
	hash, err := s.hasher.Hash(ctx, pw)
	if err != nil {
		return store.User{}, s.hashErr(err)
	}
	id, err := newID()
	if err != nil {
		return store.User{}, internal(err)
	}
	now := s.clock()
	u := store.User{ID: id, Username: username, PasswordHash: hash, CreatedAt: now, UpdatedAt: now}
	err = s.inTx(ctx, func(tx store.Tx) error {
		if err := tx.CreateUser(ctx, u); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return conflict("username is already taken")
			}
			return err
		}
		return nil
	})
	if err != nil {
		return store.User{}, err
	}
	s.ensureDefaultOrg(ctx, u)
	return u, nil
}

func (s *Service) Login(ctx context.Context, username, pw string) (LoginResult, error) {
	if err := checkUsername("username", username); err != nil {
		return LoginResult{}, err
	}
	if err := checkPassword("password", pw); err != nil {
		return LoginResult{}, err
	}
	var u store.User
	err := s.inTx(ctx, func(tx store.Tx) error {
		var err error
		u, err = tx.UserByUsername(ctx, username)
		return err
	})
	if KindOf(err) == KindInternal && errors.Is(err, store.ErrNotFound) {
		if derr := s.hasher.VerifyDummy(ctx, pw); derr != nil {
			return LoginResult{}, s.hashErr(derr)
		}
		return LoginResult{}, invalidCredentials()
	}
	if err != nil {
		return LoginResult{}, err
	}
	ok, err := s.hasher.Verify(ctx, pw, u.PasswordHash)
	if err != nil {
		return LoginResult{}, s.hashErr(err)
	}
	if !ok {
		return LoginResult{}, invalidCredentials()
	}
	if u.TOTPEnabled {
		return s.startMFA(ctx, u)
	}
	return s.finishLogin(ctx, u, func(store.Tx) error { return nil })
}

func (s *Service) startMFA(ctx context.Context, u store.User) (LoginResult, error) {
	tok, err := token.New(token.KindMFA)
	if err != nil {
		return LoginResult{}, internal(err)
	}
	now := s.clock()
	c := store.MFAChallenge{ID: tok.ID, UserID: u.ID, SecretHash: tok.Hash(), CreatedAt: now, ExpiresAt: now.Add(s.cfg.MFATTL)}
	if err := s.inTx(ctx, func(tx store.Tx) error { return tx.CreateMFAChallenge(ctx, c) }); err != nil {
		return LoginResult{}, err
	}
	return LoginResult{User: u, MFARequired: true, MFAToken: tok.String(), MFAExpiresAt: c.ExpiresAt}, nil
}

func (s *Service) finishLogin(ctx context.Context, u store.User, inTx func(store.Tx) error) (LoginResult, error) {
	tok, err := token.New(token.KindSession)
	if err != nil {
		return LoginResult{}, internal(err)
	}
	now := s.clock()
	sess := store.Session{ID: tok.ID, UserID: u.ID, SecretHash: tok.Hash(), CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(s.cfg.SessionTTL), AbsoluteExpiresAt: now.Add(s.cfg.SessionAbsolute)}
	if sess.ExpiresAt.After(sess.AbsoluteExpiresAt) {
		sess.ExpiresAt = sess.AbsoluteExpiresAt
	}
	err = s.inTx(ctx, func(tx store.Tx) error {
		if err := inTx(tx); err != nil {
			return err
		}
		return tx.CreateSession(ctx, sess)
	})
	if err != nil {
		return LoginResult{}, err
	}
	s.ensureDefaultOrg(ctx, u)
	return LoginResult{User: u, SessionToken: tok.String(), SessionExpires: sess.AbsoluteExpiresAt, SessionMaxAge: sess.AbsoluteExpiresAt.Sub(now)}, nil
}

var errVerification = errors.New("second factor rejected")

func (s *Service) LoginTOTP(ctx context.Context, mfaToken string, code, recovery *string) (LoginResult, error) {
	tok, err := token.ParseKind(mfaToken, token.KindMFA)
	if err != nil {
		return LoginResult{}, invalid("mfa_token", "must be an sdmfa token")
	}
	normalized, err := secondFactorInput(code, recovery, "code", "recovery_code")
	if err != nil {
		return LoginResult{}, err
	}
	now := s.clock()
	var c store.MFAChallenge
	var u store.User
	attempt := 0
	err = s.inTx(ctx, func(tx store.Tx) error {
		var err error
		c, err = tx.MFAChallengeByID(ctx, tok.ID)
		if errors.Is(err, store.ErrNotFound) {
			return mfaInvalid()
		}
		if err != nil {
			return err
		}
		if !token.Equal(c.SecretHash, tok.Secret) || c.UsedAt != nil || !now.Before(c.ExpiresAt) || c.FailedAttempts >= store.MaxMFAFailures {
			return mfaInvalid()
		}
		attempt, err = tx.ReserveMFAAttempt(ctx, c.ID, now)
		if err != nil {
			return err
		}
		if attempt == 0 {
			return mfaInvalid()
		}
		u, err = tx.UserByID(ctx, c.UserID)
		return err
	})
	if err != nil {
		return LoginResult{}, err
	}
	if attempt > store.MaxMFAAttempts {
		if ferr := s.failMFA(ctx, c.ID); ferr != nil {
			return LoginResult{}, ferr
		}
		return LoginResult{}, mfaInvalid()
	}
	res, err := s.finishLogin(ctx, u, func(tx store.Tx) error {
		if err := s.verifySecondFactor(ctx, tx, u.ID, code != nil, normalized, now); err != nil {
			return err
		}
		ok, err := tx.ConsumeMFAChallenge(ctx, c.ID, now)
		if err != nil {
			return err
		}
		if !ok {
			return mfaInvalid()
		}
		return nil
	})
	if errors.Is(err, errVerification) {
		if ferr := s.failMFA(ctx, c.ID); ferr != nil {
			return LoginResult{}, ferr
		}
		return LoginResult{}, mfaInvalid()
	}
	return res, err
}

func (s *Service) failMFA(ctx context.Context, id uuid.UUID) error {
	return s.inTx(ctx, func(tx store.Tx) error {
		_, err := tx.FailMFAChallenge(ctx, id)
		return err
	})
}

func secondFactorInput(code, recovery *string, codeField, recoveryField string) (string, error) {
	switch {
	case code != nil && recovery != nil:
		return "", invalid(recoveryField, "send either "+codeField+" or "+recoveryField+", not both")
	case code == nil && recovery == nil:
		return "", invalid(codeField, "is required")
	case code != nil:
		return *code, checkTOTPCode(codeField, *code)
	default:
		return checkRecoveryCode(recoveryField, *recovery)
	}
}

func (s *Service) verifySecondFactor(ctx context.Context, tx store.Tx, userID uuid.UUID, isCode bool, value string, now time.Time) error {
	u, err := tx.LockUser(ctx, userID)
	if err != nil {
		return err
	}
	if !u.TOTPEnabled || u.TOTPSecretEnc == nil {
		return errVerification
	}
	if !isCode {
		ok, err := tx.UseRecoveryCode(ctx, userID, totp.HashRecoveryCode(value), now)
		if err != nil {
			return err
		}
		if !ok {
			return errVerification
		}
		return nil
	}
	return s.verifyTOTP(ctx, tx, u, value, now)
}

func (s *Service) verifyTOTP(ctx context.Context, tx store.Tx, u store.User, code string, now time.Time) error {
	secret, err := s.cipher.Open(u.TOTPSecretEnc, u.ID[:])
	if err != nil {
		return internal(err)
	}
	step, ok := totp.Verify(secret, code, now, u.TOTPLastStep)
	if !ok {
		return errVerification
	}
	advanced, err := tx.AdvanceTOTPStep(ctx, u.ID, step)
	if err != nil {
		return err
	}
	if !advanced {
		return errVerification
	}
	return nil
}

func (s *Service) SessionFor(ctx context.Context, raw string, userID uuid.UUID) (uuid.UUID, bool) {
	tok, err := token.ParseKind(raw, token.KindSession)
	if err != nil {
		return uuid.UUID{}, false
	}
	now := s.clock()
	var ok bool
	_ = s.inTx(ctx, func(tx store.Tx) error {
		sess, err := tx.SessionByID(ctx, tok.ID)
		if err != nil {
			return err
		}
		ok = sess.UserID == userID && token.Equal(sess.SecretHash, tok.Secret) && sessionActive(sess, now)
		return nil
	})
	return tok.ID, ok
}

func sessionActive(sess store.Session, now time.Time) bool {
	return sess.RevokedAt == nil && now.Before(sess.ExpiresAt) && now.Before(sess.AbsoluteExpiresAt)
}

func (s *Service) Logout(ctx context.Context, c Caller) error {
	if !c.IsUser() || c.SessionID == nil {
		return nil
	}
	now := s.clock()
	return s.inTx(ctx, func(tx store.Tx) error {
		sess, err := tx.SessionByID(ctx, *c.SessionID)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if sess.UserID != c.ID {
			return nil
		}
		return tx.RevokeSession(ctx, sess.ID, now)
	})
}

type Me struct {
	User                   *store.User
	RecoveryCodesRemaining int
	ServiceAccount         *store.ServiceAccount
}

func (s *Service) Me(ctx context.Context, c Caller) (Me, error) {
	var me Me
	err := s.inTx(ctx, func(tx store.Tx) error {
		if c.Type == rbac.PrincipalServiceAccount {
			sa, err := tx.ServiceAccountByID(ctx, c.ID)
			if errors.Is(err, store.ErrNotFound) {
				return &Error{Kind: KindUnauthenticated, Message: "service account no longer exists"}
			}
			if err != nil {
				return err
			}
			me.ServiceAccount = &sa
			return nil
		}
		u, err := tx.UserByID(ctx, c.ID)
		if errors.Is(err, store.ErrNotFound) {
			return &Error{Kind: KindUnauthenticated, Message: "user no longer exists"}
		}
		if err != nil {
			return err
		}
		n, err := tx.CountUnusedRecoveryCodes(ctx, u.ID)
		if err != nil {
			return err
		}
		if !u.TOTPEnabled {
			n = 0
		}
		me.User = &u
		me.RecoveryCodesRemaining = n
		return nil
	})
	return me, err
}

func requireUser(c Caller) error {
	if !c.IsUser() {
		return forbidden("only users can use this endpoint")
	}
	return nil
}

func requireSession(c Caller) error {
	if err := requireUser(c); err != nil {
		return err
	}
	if c.SessionID == nil {
		return forbidden("this endpoint requires a browser session, API tokens are not accepted")
	}
	return nil
}

type TOTPSetup struct {
	Secret string
	URI    string
}

func (s *Service) TOTPSetup(ctx context.Context, c Caller) (TOTPSetup, error) {
	if err := requireSession(c); err != nil {
		return TOTPSetup{}, err
	}
	secret, err := totp.NewSecret()
	if err != nil {
		return TOTPSetup{}, internal(err)
	}
	var out TOTPSetup
	err = s.inTx(ctx, func(tx store.Tx) error {
		u, err := tx.LockUser(ctx, c.ID)
		if err != nil {
			return err
		}
		if u.TOTPEnabled {
			return conflict("TOTP is already enabled")
		}
		enc, err := s.cipher.Seal(secret, u.ID[:])
		if err != nil {
			return err
		}
		if err := tx.UpdateUserTOTP(ctx, u.ID, enc, false, nil, s.clock()); err != nil {
			return err
		}
		out = TOTPSetup{Secret: totp.EncodeSecret(secret), URI: totp.URI(s.cfg.TOTPIssuer, u.Username, secret)}
		return nil
	})
	return out, err
}

func (s *Service) newRecoveryCodes(ctx context.Context, tx store.Tx, userID uuid.UUID, now time.Time) ([]string, error) {
	codes, err := totp.NewRecoveryCodes()
	if err != nil {
		return nil, err
	}
	rows := make([]store.RecoveryCode, 0, len(codes))
	for _, code := range codes {
		id, err := newID()
		if err != nil {
			return nil, err
		}
		rows = append(rows, store.RecoveryCode{ID: id, UserID: userID, CodeHash: totp.HashRecoveryCode(code), CreatedAt: now})
	}
	if err := tx.ReplaceRecoveryCodes(ctx, userID, rows); err != nil {
		return nil, err
	}
	return codes, nil
}

func (s *Service) TOTPEnable(ctx context.Context, c Caller, code string) ([]string, error) {
	if err := requireSession(c); err != nil {
		return nil, err
	}
	if err := checkTOTPCode("code", code); err != nil {
		return nil, err
	}
	now := s.clock()
	var codes []string
	err := s.inTx(ctx, func(tx store.Tx) error {
		u, err := tx.LockUser(ctx, c.ID)
		if err != nil {
			return err
		}
		if u.TOTPEnabled {
			return conflict("TOTP is already enabled")
		}
		if u.TOTPSecretEnc == nil {
			return conflict("start enrollment with POST /auth/totp/setup first")
		}
		if err := s.verifyTOTP(ctx, tx, u, code, now); err != nil {
			return err
		}
		u, err = tx.UserByID(ctx, c.ID)
		if err != nil {
			return err
		}
		if err := tx.UpdateUserTOTP(ctx, u.ID, u.TOTPSecretEnc, true, u.TOTPLastStep, now); err != nil {
			return err
		}
		codes, err = s.newRecoveryCodes(ctx, tx, u.ID, now)
		return err
	})
	if errors.Is(err, errVerification) {
		return nil, mfaInvalid()
	}
	return codes, err
}

func (s *Service) checkPasswordOf(ctx context.Context, c Caller, pw string) (store.User, error) {
	var u store.User
	if err := s.inTx(ctx, func(tx store.Tx) error {
		var err error
		u, err = tx.UserByID(ctx, c.ID)
		return err
	}); err != nil {
		return u, err
	}
	if !u.TOTPEnabled {
		return u, conflict("TOTP is not enabled")
	}
	ok, err := s.hasher.Verify(ctx, pw, u.PasswordHash)
	if err != nil {
		return u, s.hashErr(err)
	}
	if !ok {
		return u, invalidCredentials()
	}
	return u, nil
}

func (s *Service) TOTPDisable(ctx context.Context, c Caller, pw string, code, recovery *string) error {
	if err := requireSession(c); err != nil {
		return err
	}
	if err := checkPassword("password", pw); err != nil {
		return err
	}
	value, err := secondFactorInput(code, recovery, "code", "recovery_code")
	if err != nil {
		return err
	}
	if _, err := s.checkPasswordOf(ctx, c, pw); err != nil {
		return err
	}
	now := s.clock()
	err = s.inTx(ctx, func(tx store.Tx) error {
		if err := s.verifySecondFactor(ctx, tx, c.ID, code != nil, value, now); err != nil {
			return err
		}
		if err := tx.UpdateUserTOTP(ctx, c.ID, nil, false, nil, now); err != nil {
			return err
		}
		return tx.DeleteRecoveryCodes(ctx, c.ID)
	})
	if errors.Is(err, errVerification) {
		return mfaInvalid()
	}
	return err
}

func (s *Service) RegenerateRecoveryCodes(ctx context.Context, c Caller, pw, code string) ([]string, error) {
	if err := requireSession(c); err != nil {
		return nil, err
	}
	if err := checkPassword("password", pw); err != nil {
		return nil, err
	}
	if err := checkTOTPCode("code", code); err != nil {
		return nil, err
	}
	if _, err := s.checkPasswordOf(ctx, c, pw); err != nil {
		return nil, err
	}
	now := s.clock()
	var codes []string
	err := s.inTx(ctx, func(tx store.Tx) error {
		if err := s.verifySecondFactor(ctx, tx, c.ID, true, code, now); err != nil {
			return err
		}
		var err error
		codes, err = s.newRecoveryCodes(ctx, tx, c.ID, now)
		return err
	})
	if errors.Is(err, errVerification) {
		return nil, mfaInvalid()
	}
	return codes, err
}
