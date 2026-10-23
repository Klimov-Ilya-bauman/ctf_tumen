package core

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"slopdns/web/iam/internal/password"
	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/totp"
	"slopdns/web/pkg/rbac"
)

// Embedded Tx deliberately panics for unexpected operations. Reservations and
// challenge state are rolled back on errors, like the real transactional store.
type factorStore struct {
	store.Tx
	mu            sync.Mutex
	u             store.User
	challenges    map[uuid.UUID]store.MFAChallenge
	attempts      int
	until         time.Time
	verifications int
}

func (f *factorStore) InTx(_ context.Context, fn func(store.Tx) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	oldAttempts, oldUntil, oldUser := f.attempts, f.until, f.u
	oldChallenges := make(map[uuid.UUID]store.MFAChallenge)
	for k, v := range f.challenges {
		oldChallenges[k] = v
	}
	err := fn(f)
	if err != nil {
		f.attempts, f.until, f.challenges, f.u = oldAttempts, oldUntil, oldChallenges, oldUser
	}
	return err
}
func (f *factorStore) WithTryLock(context.Context, int64, func(store.Tx) error) (bool, error) {
	panic("unused")
}
func (f *factorStore) UserByID(context.Context, uuid.UUID) (store.User, error) { return f.u, nil }
func (f *factorStore) LockUser(context.Context, uuid.UUID) (store.User, error) { return f.u, nil }
func (f *factorStore) CreateMFAChallenge(_ context.Context, c store.MFAChallenge) error {
	f.challenges[c.ID] = c
	return nil
}
func (f *factorStore) MFAChallengeByID(_ context.Context, id uuid.UUID) (store.MFAChallenge, error) {
	c, ok := f.challenges[id]
	if !ok {
		return c, store.ErrNotFound
	}
	return c, nil
}
func (f *factorStore) ReserveMFAAttempt(_ context.Context, id uuid.UUID, _ time.Time) (int, error) {
	c := f.challenges[id]
	c.Attempts++
	f.challenges[id] = c
	return c.Attempts, nil
}
func (f *factorStore) FailMFAChallenge(_ context.Context, id uuid.UUID) (int, error) {
	c := f.challenges[id]
	c.FailedAttempts++
	f.challenges[id] = c
	return c.FailedAttempts, nil
}
func (f *factorStore) ReserveSecondFactorAttempt(_ context.Context, _ uuid.UUID, now time.Time) (bool, error) {
	if !now.Before(f.until) {
		f.attempts = 0
		f.until = now.Add(store.SecondFactorCooldown)
	}
	if f.attempts >= store.MaxSecondFactorAttempts {
		return false, nil
	}
	f.attempts++
	return true, nil
}
func (f *factorStore) UseRecoveryCode(context.Context, uuid.UUID, []byte, time.Time) (bool, error) {
	f.verifications++
	return false, nil
}

func (f *factorStore) AdvanceTOTPStep(_ context.Context, _ uuid.UUID, step int64) (bool, error) {
	if f.u.TOTPLastStep != nil && step <= *f.u.TOTPLastStep {
		return false, nil
	}
	f.u.TOTPLastStep = &step
	return true, nil
}
func (f *factorStore) UpdateUserTOTP(_ context.Context, _ uuid.UUID, enc []byte, enabled bool, step *int64, _ time.Time) error {
	f.u.TOTPSecretEnc, f.u.TOTPEnabled, f.u.TOTPLastStep = enc, enabled, step
	return nil
}
func (f *factorStore) ReplaceRecoveryCodes(context.Context, uuid.UUID, []store.RecoveryCode) error {
	return nil
}
func (f *factorStore) DeleteRecoveryCodes(context.Context, uuid.UUID) error { return nil }

func TestFreshChallengesShareCommittedAccountBudget(t *testing.T) {
	now := time.Unix(1700000000, 0)
	f := &factorStore{u: store.User{ID: uuid.New(), TOTPEnabled: true, TOTPSecretEnc: []byte{1}}, challenges: map[uuid.UUID]store.MFAChallenge{}}
	s := &Service{store: f, now: func() time.Time { return now }, cfg: DefaultConfig()}
	ctx := context.Background()
	recovery := "AAAABBBBCCCCDDDD"
	for range store.MaxSecondFactorAttempts + 3 {
		challenge, err := s.startMFA(ctx, f.u)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.LoginTOTP(ctx, challenge.MFAToken, nil, &recovery); err == nil {
			t.Fatal("invalid recovery code accepted")
		}
	}
	if f.attempts != store.MaxSecondFactorAttempts || f.verifications != store.MaxSecondFactorAttempts {
		t.Fatalf("attempts=%d verifications=%d", f.attempts, f.verifications)
	}
	now = now.Add(store.SecondFactorCooldown)
	challenge, err := s.startMFA(ctx, f.u)
	if err != nil {
		t.Fatal(err)
	}
	s.LoginTOTP(ctx, challenge.MFAToken, nil, &recovery)
	if f.verifications != store.MaxSecondFactorAttempts+1 {
		t.Fatal("cooldown did not restore verification")
	}
}

func TestSensitiveOperationsShareAccountBudget(t *testing.T) {
	now := time.Unix(1700000000, 0)
	ctx := context.Background()
	h, err := password.NewHasher(password.Params{Memory: 8, Time: 1, Threads: 1, SaltLen: 8, KeyLen: 16}, 1, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	pw := "test-password-123"
	hash, err := h.Hash(ctx, pw)
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := totp.NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	secret := []byte("01234567890123456789")
	enc, err := cipher.Seal(secret, id[:])
	if err != nil {
		t.Fatal(err)
	}
	f := &factorStore{u: store.User{ID: id, PasswordHash: hash, TOTPSecretEnc: enc}, challenges: map[uuid.UUID]store.MFAChallenge{}}
	s := &Service{store: f, hasher: h, cipher: cipher, now: func() time.Time { return now }, cfg: DefaultConfig()}
	session := uuid.New()
	caller := Caller{Type: rbac.PrincipalUser, ID: id, SessionID: &session}
	wrong := "000000"
	for _, step := range []int64{-1, 0, 1} {
		if wrong == totp.Code(secret, totp.Step(now)+step) {
			wrong = "000001"
		}
	}
	// A failed enrollment verification must spend the same budget as login,
	// disable and regeneration, even though its main transaction rolls back.
	if _, err := s.TOTPEnable(ctx, caller, wrong); err == nil {
		t.Fatal("invalid enrollment accepted")
	}
	f.u.TOTPEnabled = true
	recovery := "AAAABBBBCCCCDDDD"
	for range store.MaxSecondFactorAttempts - 1 {
		if err := s.TOTPDisable(ctx, caller, pw, nil, &recovery); err == nil {
			t.Fatal("invalid disable accepted")
		}
	}
	valid := totp.Code(secret, totp.Step(now))
	if _, err := s.RegenerateRecoveryCodes(ctx, caller, pw, valid); err == nil {
		t.Fatal("regeneration bypassed exhausted account budget")
	}
	f.u.TOTPEnabled = false
	if _, err := s.TOTPEnable(ctx, caller, valid); err == nil {
		t.Fatal("enrollment bypassed exhausted account budget")
	}
	if f.attempts != store.MaxSecondFactorAttempts {
		t.Fatalf("attempts=%d", f.attempts)
	}
	// Legitimate enrollment, regeneration and disable continue after cooldown.
	now = now.Add(store.SecondFactorCooldown)
	valid = totp.Code(secret, totp.Step(now))
	if codes, err := s.TOTPEnable(ctx, caller, valid); err != nil || len(codes) != totp.RecoveryCodeCount {
		t.Fatalf("legitimate enable: %d codes, %v", len(codes), err)
	}
	now = now.Add(30 * time.Second)
	valid = totp.Code(secret, totp.Step(now))
	if codes, err := s.RegenerateRecoveryCodes(ctx, caller, pw, valid); err != nil || len(codes) != totp.RecoveryCodeCount {
		t.Fatalf("legitimate regeneration: %d codes, %v", len(codes), err)
	}
	now = now.Add(30 * time.Second)
	valid = totp.Code(secret, totp.Step(now))
	if err := s.TOTPDisable(ctx, caller, pw, &valid, nil); err != nil {
		t.Fatalf("legitimate disable: %v", err)
	}
	// The reservation transaction itself must fail closed on DB errors.
	failed := &reservationFailure{factorStore: f}
	s.store = failed
	if err := s.reserveSecondFactor(ctx, id, now); err == nil {
		t.Fatal("database failure allowed verification")
	}
}

type reservationFailure struct{ *factorStore }

func (f *reservationFailure) InTx(context.Context, func(store.Tx) error) error {
	return errors.New("database unavailable")
}
