package core

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"slopdns/web/iam/internal/store"
	"slopdns/web/pkg/rbac"
)

func (f *factorStore) ReserveSessionTOTPAttempt(context.Context, uuid.UUID) (int, error) {
	return 1, nil
}

func TestTokenCreationCannotBypassExhaustedAccountBudgetAcrossSessions(t *testing.T) {
	now := time.Unix(1700000000, 0)
	f := &factorStore{u: store.User{ID: uuid.New(), TOTPEnabled: true}, attempts: store.MaxSecondFactorAttempts, until: now.Add(time.Minute)}
	s := &Service{store: f, now: func() time.Time { return now }, cfg: DefaultConfig()}
	code := "000000"
	for range 3 {
		session := uuid.New()
		caller := Caller{Type: rbac.PrincipalUser, ID: f.u.ID, SessionID: &session}
		// No Cipher is configured: reaching verification would panic. Exhaustion
		// must reject even though each session's local attempt allowance is fresh.
		if _, err := s.CreateMyToken(context.Background(), caller, TokenRequest{Name: "audit", TOTPCode: &code}); KindOf(err) != KindMFAInvalid {
			t.Fatalf("exhausted account was not rejected: %v", err)
		}
	}
}

type changingOrgTx struct {
	store.Tx
	initial, joined store.Principal
	lists, locks    int
}

func (q *changingOrgTx) ListBindings(context.Context, store.BindingFilter, store.Page) ([]store.RoleBinding, int, error) {
	q.lists++
	bs := []store.RoleBinding{{Principal: q.initial}}
	if q.lists > 1 {
		bs = append(bs, store.RoleBinding{Principal: q.joined})
	}
	return bs, len(bs), nil
}
func (q *changingOrgTx) LockUser(_ context.Context, id uuid.UUID) (store.User, error) {
	q.locks++
	if id != q.initial.ID {
		panic("expanded held lock set; potential ownership-transfer deadlock")
	}
	return store.User{ID: id}, nil
}

type lateServiceAccountBindingTx struct {
	changingOrgTx
	sa    store.ServiceAccount
	empty bool
}

func (q *lateServiceAccountBindingTx) ListBindings(_ context.Context, f store.BindingFilter, _ store.Page) ([]store.RoleBinding, int, error) {
	if f.OrgID != nil {
		if q.empty {
			return nil, 0, nil
		}
		return []store.RoleBinding{{Principal: q.initial}}, 1, nil
	}
	if f.ResourceType == rbac.ResourceServiceAccount {
		return []store.RoleBinding{{Principal: q.joined}}, 1, nil
	}
	return nil, 0, nil
}
func (q *lateServiceAccountBindingTx) ServiceAccountIDsByOrg(context.Context, uuid.UUID) ([]uuid.UUID, error) {
	return []uuid.UUID{q.sa.ID}, nil
}
func (q *lateServiceAccountBindingTx) ServiceAccountByID(context.Context, uuid.UUID) (store.ServiceAccount, error) {
	return q.sa, nil
}
func (q *lateServiceAccountBindingTx) DeleteBindingsIncludingOwner(context.Context, []uuid.UUID) ([]store.RoleBinding, error) {
	return []store.RoleBinding{{Principal: q.initial}}, nil
}
func (q *lateServiceAccountBindingTx) BumpAuthzVersions(context.Context, []store.Principal) error {
	return nil
}

func TestOrgRevocationRejectsLateServiceAccountUserLocks(t *testing.T) {
	for _, empty := range []bool{false, true} {
		q := &lateServiceAccountBindingTx{changingOrgTx: changingOrgTx{initial: store.Principal{Type: rbac.PrincipalUser, ID: uuid.MustParse("ffffffff-ffff-4fff-8fff-ffffffffffff")}, joined: store.Principal{Type: rbac.PrincipalUser, ID: uuid.MustParse("00000000-0000-4000-8000-000000000001")}}, sa: store.ServiceAccount{ID: uuid.New()}, empty: empty}
		n := 0
		err := (&Service{}).revokeOrg(context.Background(), q, uuid.New(), &n)
		if KindOf(err) != KindConflict {
			t.Fatalf("empty=%v: %v", empty, err)
		}
	}
}

func TestOrgRevocationRestartsRatherThanExpandingUserLocks(t *testing.T) {
	q := &changingOrgTx{initial: store.Principal{Type: rbac.PrincipalUser, ID: uuid.MustParse("ffffffff-ffff-4fff-8fff-ffffffffffff")}, joined: store.Principal{Type: rbac.PrincipalUser, ID: uuid.MustParse("00000000-0000-4000-8000-000000000001")}}
	s := &Service{}
	n := 0
	err := s.revokeOrg(context.Background(), q, uuid.New(), &n)
	if KindOf(err) != KindConflict || q.lists != 2 || q.locks != 1 || n != 0 {
		t.Fatalf("err=%v lists=%d locks=%d deleted=%d", err, q.lists, q.locks, n)
	}
}
