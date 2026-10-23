package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"slopdns/web/pkg/rbac"
)

var (
	ErrNotFound      = errors.New("store: not found")
	ErrConflict      = errors.New("store: conflict")
	ErrOwnerConflict = errors.New("store: organization already has an owner")
)

const (
	MaxMFAFailures         = 5
	MaxMFAAttempts         = 5
	MaxSessionTOTPFailures = 5
)

type User struct {
	ID            uuid.UUID
	Username      string
	PasswordHash  string
	TOTPSecretEnc []byte
	TOTPEnabled   bool
	TOTPLastStep  *int64
	AuthzVersion  int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type Session struct {
	ID                uuid.UUID
	UserID            uuid.UUID
	SecretHash        []byte
	CreatedAt         time.Time
	LastSeenAt        time.Time
	ExpiresAt         time.Time
	AbsoluteExpiresAt time.Time
	RevokedAt         *time.Time
	TOTPFailures      int
}

type MFAChallenge struct {
	ID             uuid.UUID
	UserID         uuid.UUID
	SecretHash     []byte
	CreatedAt      time.Time
	ExpiresAt      time.Time
	UsedAt         *time.Time
	FailedAttempts int
	Attempts       int
}

type RecoveryCode struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	CodeHash  []byte
	CreatedAt time.Time
	UsedAt    *time.Time
}

type ServiceAccount struct {
	ID           uuid.UUID
	OrgID        uuid.UUID
	Name         string
	Description  string
	AuthzVersion int64
	CreatedBy    uuid.UUID
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type OwnerType string

const (
	OwnerUser           OwnerType = "user"
	OwnerServiceAccount OwnerType = "service_account"
)

type APIToken struct {
	ID         uuid.UUID
	OwnerType  OwnerType
	OwnerID    uuid.UUID
	Name       string
	SecretHash []byte
	CreatedBy  uuid.UUID
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
}

type Principal struct {
	Type rbac.PrincipalType
	ID   uuid.UUID
}

type RoleBinding struct {
	ID           uuid.UUID
	Principal    Principal
	ResourceType rbac.ResourceType
	ResourceID   uuid.UUID
	OrgID        uuid.UUID
	Role         rbac.Role
	GrantedBy    *uuid.UUID
	CreatedAt    time.Time
}

func (b RoleBinding) RBAC() rbac.Binding {
	return rbac.Binding{ResourceType: b.ResourceType, ResourceID: b.ResourceID.String(), OrgID: b.OrgID.String(), Role: b.Role}
}

type BindingFilter struct {
	Principal    *Principal
	ResourceType rbac.ResourceType
	ResourceID   *uuid.UUID
	OrgID        *uuid.UUID
}

type Page struct {
	Limit  int
	Offset int
}

type BindingResource struct {
	ResourceType    rbac.ResourceType
	ResourceID      uuid.UUID
	OrgID           uuid.UUID
	Count           int
	LatestCreatedAt time.Time
}

type BindingResourceKey struct {
	ResourceType rbac.ResourceType
	ResourceID   uuid.UUID
	OrgID        uuid.UUID
}

func (k BindingResourceKey) Less(o BindingResourceKey) bool {
	if k.ResourceType != o.ResourceType {
		return k.ResourceType < o.ResourceType
	}
	if k.ResourceID != o.ResourceID {
		return k.ResourceID.String() < o.ResourceID.String()
	}
	return k.OrgID.String() < o.OrgID.String()
}

func (r BindingResource) Key() BindingResourceKey {
	return BindingResourceKey{ResourceType: r.ResourceType, ResourceID: r.ResourceID, OrgID: r.OrgID}
}

type CleanupPolicy struct {
	Now               time.Time
	RevokedRetention  time.Duration
	ExpiredRetention  time.Duration
	MFARetention      time.Duration
	RecoveryRetention time.Duration
}

type CleanupResult struct {
	Sessions      int64
	MFAChallenges int64
	APITokens     int64
	RecoveryCodes int64
}

type Store interface {
	InTx(ctx context.Context, fn func(Tx) error) error
	WithTryLock(ctx context.Context, key int64, fn func(Tx) error) (bool, error)
}

type Tx interface {
	CreateUser(ctx context.Context, u User) error
	UserByID(ctx context.Context, id uuid.UUID) (User, error)
	UserByUsername(ctx context.Context, username string) (User, error)
	LockUser(ctx context.Context, id uuid.UUID) (User, error)
	UsersByIDs(ctx context.Context, ids []uuid.UUID) ([]User, error)
	UsersByUsernames(ctx context.Context, names []string) ([]User, error)
	UpdateUserTOTP(ctx context.Context, id uuid.UUID, secretEnc []byte, enabled bool, lastStep *int64, now time.Time) error
	AdvanceTOTPStep(ctx context.Context, id uuid.UUID, step int64) (bool, error)
	BumpAuthzVersions(ctx context.Context, principals []Principal) error

	ReplaceRecoveryCodes(ctx context.Context, userID uuid.UUID, codes []RecoveryCode) error
	DeleteRecoveryCodes(ctx context.Context, userID uuid.UUID) error
	UseRecoveryCode(ctx context.Context, userID uuid.UUID, codeHash []byte, now time.Time) (bool, error)
	CountUnusedRecoveryCodes(ctx context.Context, userID uuid.UUID) (int, error)

	CreateSession(ctx context.Context, s Session) error
	SessionByID(ctx context.Context, id uuid.UUID) (Session, error)
	TouchSession(ctx context.Context, id uuid.UUID, lastSeen, expiresAt, staleBefore time.Time) error
	RevokeSession(ctx context.Context, id uuid.UUID, now time.Time) error
	ReserveSessionTOTPAttempt(ctx context.Context, id uuid.UUID) (int, error)
	RefundSessionTOTPAttempt(ctx context.Context, id uuid.UUID) error

	CreateMFAChallenge(ctx context.Context, c MFAChallenge) error
	MFAChallengeByID(ctx context.Context, id uuid.UUID) (MFAChallenge, error)
	ConsumeMFAChallenge(ctx context.Context, id uuid.UUID, now time.Time) (bool, error)
	ReserveMFAAttempt(ctx context.Context, id uuid.UUID, now time.Time) (int, error)
	FailMFAChallenge(ctx context.Context, id uuid.UUID) (int, error)

	CreateAPIToken(ctx context.Context, t APIToken) error
	APITokenByID(ctx context.Context, id uuid.UUID) (APIToken, error)
	ListAPITokens(ctx context.Context, owner OwnerType, ownerID uuid.UUID, page Page) ([]APIToken, int, error)
	RevokeAPIToken(ctx context.Context, id uuid.UUID, owner OwnerType, ownerID uuid.UUID, now time.Time) (bool, error)
	TouchAPIToken(ctx context.Context, id uuid.UUID, now, staleBefore time.Time) error
	DeleteAPITokensByOwner(ctx context.Context, owner OwnerType, ownerID uuid.UUID) error

	CreateServiceAccount(ctx context.Context, sa ServiceAccount) error
	ServiceAccountByID(ctx context.Context, id uuid.UUID) (ServiceAccount, error)
	ServiceAccountsByIDs(ctx context.Context, ids []uuid.UUID) ([]ServiceAccount, error)
	ListServiceAccounts(ctx context.Context, orgID uuid.UUID, only []uuid.UUID, page Page) ([]ServiceAccount, int, error)
	UpdateServiceAccount(ctx context.Context, sa ServiceAccount) error
	DeleteServiceAccount(ctx context.Context, id uuid.UUID) error
	ServiceAccountIDsByOrg(ctx context.Context, orgID uuid.UUID) ([]uuid.UUID, error)

	CreateBinding(ctx context.Context, b RoleBinding) error
	BindingByID(ctx context.Context, id uuid.UUID) (RoleBinding, error)
	BindingFor(ctx context.Context, p Principal, rt rbac.ResourceType, resourceID uuid.UUID) (RoleBinding, error)
	OrgOwner(ctx context.Context, orgID uuid.UUID, forUpdate bool) (RoleBinding, error)
	UpdateBinding(ctx context.Context, b RoleBinding) error
	DeleteBindings(ctx context.Context, ids []uuid.UUID) ([]RoleBinding, error)
	ListBindings(ctx context.Context, f BindingFilter, page Page) ([]RoleBinding, int, error)
	ListBindingResources(ctx context.Context, rt rbac.ResourceType, after *BindingResourceKey, limit int) ([]BindingResource, error)
	ListServiceAccountRefs(ctx context.Context, after *uuid.UUID, limit int) ([]ServiceAccount, error)

	Cleanup(ctx context.Context, p CleanupPolicy) (CleanupResult, error)
}
