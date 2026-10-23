package pgstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"slopdns/web/iam/internal/store"
	"slopdns/web/pkg/pg"
	"slopdns/web/pkg/rbac"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) InTx(ctx context.Context, fn func(store.Tx) error) error {
	return pg.InTx(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(t pgx.Tx) error {
		return fn(&tx{q: t})
	})
}

func (s *Store) WithTryLock(ctx context.Context, key int64, fn func(store.Tx) error) (bool, error) {
	acquired := false
	err := pg.InTx(ctx, s.pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, func(t pgx.Tx) error {
		if err := t.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock($1)", key).Scan(&acquired); err != nil {
			return err
		}
		if !acquired {
			return nil
		}
		return fn(&tx{q: t})
	})
	return acquired, err
}

type tx struct {
	q pgx.Tx
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return store.ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			if pgErr.ConstraintName == "role_bindings_single_owner_idx" {
				return store.ErrOwnerConflict
			}
			return store.ErrConflict
		case "23503":
			return store.ErrNotFound
		}
	}
	return err
}

func limitOffset(p store.Page, args []any) (string, []any) {
	sql := ""
	if p.Limit > 0 {
		args = append(args, p.Limit)
		sql += fmt.Sprintf(" LIMIT $%d", len(args))
	}
	if p.Offset > 0 {
		args = append(args, p.Offset)
		sql += fmt.Sprintf(" OFFSET $%d", len(args))
	}
	return sql, args
}

const userCols = "id, username, password_hash, totp_secret_enc, totp_enabled, totp_last_step, authz_version, created_at, updated_at"

func scanUser(row pgx.Row) (store.User, error) {
	var u store.User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.TOTPSecretEnc, &u.TOTPEnabled, &u.TOTPLastStep, &u.AuthzVersion, &u.CreatedAt, &u.UpdatedAt)
	return u, mapErr(err)
}

func collect[T any](rows pgx.Rows, err error, scan func(pgx.Row) (T, error)) ([]T, error) {
	if err != nil {
		return nil, mapErr(err)
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, mapErr(rows.Err())
}

func (t *tx) CreateUser(ctx context.Context, u store.User) error {
	_, err := t.q.Exec(ctx, `INSERT INTO iam.users (id, username, password_hash, totp_secret_enc, totp_enabled, totp_last_step, authz_version, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, u.ID, u.Username, u.PasswordHash, u.TOTPSecretEnc, u.TOTPEnabled, u.TOTPLastStep, u.AuthzVersion, u.CreatedAt, u.UpdatedAt)
	return mapErr(err)
}

func (t *tx) UserByID(ctx context.Context, id uuid.UUID) (store.User, error) {
	return scanUser(t.q.QueryRow(ctx, "SELECT "+userCols+" FROM iam.users WHERE id = $1", id))
}

func (t *tx) LockUser(ctx context.Context, id uuid.UUID) (store.User, error) {
	return scanUser(t.q.QueryRow(ctx, "SELECT "+userCols+" FROM iam.users WHERE id = $1 FOR UPDATE", id))
}

func (t *tx) UserByUsername(ctx context.Context, username string) (store.User, error) {
	return scanUser(t.q.QueryRow(ctx, "SELECT "+userCols+" FROM iam.users WHERE username = $1", username))
}

func (t *tx) UsersByIDs(ctx context.Context, ids []uuid.UUID) ([]store.User, error) {
	rows, err := t.q.Query(ctx, "SELECT "+userCols+" FROM iam.users WHERE id = ANY($1) ORDER BY username", ids)
	return collect(rows, err, scanUser)
}

func (t *tx) UsersByUsernames(ctx context.Context, names []string) ([]store.User, error) {
	rows, err := t.q.Query(ctx, "SELECT "+userCols+" FROM iam.users WHERE username = ANY($1) ORDER BY username", names)
	return collect(rows, err, scanUser)
}

func (t *tx) UpdateUserTOTP(ctx context.Context, id uuid.UUID, secretEnc []byte, enabled bool, lastStep *int64, now time.Time) error {
	tag, err := t.q.Exec(ctx, "UPDATE iam.users SET totp_secret_enc = $2, totp_enabled = $3, totp_last_step = $4, updated_at = $5 WHERE id = $1", id, secretEnc, enabled, lastStep, now)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) AdvanceTOTPStep(ctx context.Context, id uuid.UUID, step int64) (bool, error) {
	tag, err := t.q.Exec(ctx, "UPDATE iam.users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)", id, step)
	if err != nil {
		return false, mapErr(err)
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	if _, err := t.UserByID(ctx, id); err != nil {
		return false, err
	}
	return false, nil
}

func (t *tx) BumpAuthzVersions(ctx context.Context, principals []store.Principal) error {
	var users, sas []uuid.UUID
	for _, p := range principals {
		switch p.Type {
		case rbac.PrincipalUser:
			users = append(users, p.ID)
		case rbac.PrincipalServiceAccount:
			sas = append(sas, p.ID)
		}
	}
	if len(users) > 0 {
		if _, err := t.q.Exec(ctx, "UPDATE iam.users SET authz_version = authz_version + 1 WHERE id = ANY($1)", users); err != nil {
			return mapErr(err)
		}
	}
	if len(sas) > 0 {
		if _, err := t.q.Exec(ctx, "UPDATE iam.service_accounts SET authz_version = authz_version + 1 WHERE id = ANY($1)", sas); err != nil {
			return mapErr(err)
		}
	}
	return nil
}

func (t *tx) ReplaceRecoveryCodes(ctx context.Context, userID uuid.UUID, codes []store.RecoveryCode) error {
	if err := t.DeleteRecoveryCodes(ctx, userID); err != nil {
		return err
	}
	for _, c := range codes {
		if c.UserID != userID {
			return store.ErrNotFound
		}
		if _, err := t.q.Exec(ctx, "INSERT INTO iam.totp_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES ($1, $2, $3, $4, $5)", c.ID, c.UserID, c.CodeHash, c.UsedAt, c.CreatedAt); err != nil {
			return mapErr(err)
		}
	}
	return nil
}

func (t *tx) DeleteRecoveryCodes(ctx context.Context, userID uuid.UUID) error {
	_, err := t.q.Exec(ctx, "DELETE FROM iam.totp_recovery_codes WHERE user_id = $1", userID)
	return mapErr(err)
}

func (t *tx) UseRecoveryCode(ctx context.Context, userID uuid.UUID, codeHash []byte, now time.Time) (bool, error) {
	tag, err := t.q.Exec(ctx, "UPDATE iam.totp_recovery_codes SET used_at = $3 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL", userID, codeHash, now)
	if err != nil {
		return false, mapErr(err)
	}
	return tag.RowsAffected() == 1, nil
}

func (t *tx) CountUnusedRecoveryCodes(ctx context.Context, userID uuid.UUID) (int, error) {
	var n int
	err := t.q.QueryRow(ctx, "SELECT count(*) FROM iam.totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL", userID).Scan(&n)
	return n, mapErr(err)
}

const sessionCols = "id, user_id, secret_hash, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at, totp_failures"

func (t *tx) CreateSession(ctx context.Context, s store.Session) error {
	_, err := t.q.Exec(ctx, "INSERT INTO iam.sessions ("+sessionCols+") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", s.ID, s.UserID, s.SecretHash, s.CreatedAt, s.LastSeenAt, s.ExpiresAt, s.AbsoluteExpiresAt, s.RevokedAt, s.TOTPFailures)
	return mapErr(err)
}

func (t *tx) SessionByID(ctx context.Context, id uuid.UUID) (store.Session, error) {
	var s store.Session
	err := t.q.QueryRow(ctx, "SELECT "+sessionCols+" FROM iam.sessions WHERE id = $1", id).Scan(&s.ID, &s.UserID, &s.SecretHash, &s.CreatedAt, &s.LastSeenAt, &s.ExpiresAt, &s.AbsoluteExpiresAt, &s.RevokedAt, &s.TOTPFailures)
	return s, mapErr(err)
}

func (t *tx) TouchSession(ctx context.Context, id uuid.UUID, lastSeen, expiresAt, staleBefore time.Time) error {
	_, err := t.q.Exec(ctx, "UPDATE iam.sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1 AND last_seen_at < $4", id, lastSeen, expiresAt, staleBefore)
	return mapErr(err)
}

func (t *tx) RevokeSession(ctx context.Context, id uuid.UUID, now time.Time) error {
	_, err := t.q.Exec(ctx, "UPDATE iam.sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", id, now)
	return mapErr(err)
}

func (t *tx) ReserveSessionTOTPAttempt(ctx context.Context, id uuid.UUID) (int, error) {
	var n int
	err := t.q.QueryRow(ctx, "UPDATE iam.sessions SET totp_failures = totp_failures + 1 WHERE id = $1 AND revoked_at IS NULL AND totp_failures < $2 RETURNING totp_failures", id, store.MaxSessionTOTPFailures).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, mapErr(err)
}

func (t *tx) RefundSessionTOTPAttempt(ctx context.Context, id uuid.UUID) error {
	_, err := t.q.Exec(ctx, "UPDATE iam.sessions SET totp_failures = totp_failures - 1 WHERE id = $1 AND totp_failures > 0", id)
	return mapErr(err)
}

func (t *tx) CreateMFAChallenge(ctx context.Context, c store.MFAChallenge) error {
	_, err := t.q.Exec(ctx, "INSERT INTO iam.mfa_challenges (id, user_id, secret_hash, created_at, expires_at, used_at, failed_attempts, attempts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", c.ID, c.UserID, c.SecretHash, c.CreatedAt, c.ExpiresAt, c.UsedAt, c.FailedAttempts, c.Attempts)
	return mapErr(err)
}

func (t *tx) MFAChallengeByID(ctx context.Context, id uuid.UUID) (store.MFAChallenge, error) {
	var c store.MFAChallenge
	err := t.q.QueryRow(ctx, "SELECT id, user_id, secret_hash, created_at, expires_at, used_at, failed_attempts, attempts FROM iam.mfa_challenges WHERE id = $1", id).Scan(&c.ID, &c.UserID, &c.SecretHash, &c.CreatedAt, &c.ExpiresAt, &c.UsedAt, &c.FailedAttempts, &c.Attempts)
	return c, mapErr(err)
}

func (t *tx) ConsumeMFAChallenge(ctx context.Context, id uuid.UUID, now time.Time) (bool, error) {
	tag, err := t.q.Exec(ctx, "UPDATE iam.mfa_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2 AND failed_attempts < $3", id, now, store.MaxMFAFailures)
	if err != nil {
		return false, mapErr(err)
	}
	return tag.RowsAffected() == 1, nil
}

func (t *tx) ReserveMFAAttempt(ctx context.Context, id uuid.UUID, now time.Time) (int, error) {
	var n int
	err := t.q.QueryRow(ctx, "UPDATE iam.mfa_challenges SET attempts = attempts + 1 WHERE id = $1 AND used_at IS NULL AND expires_at > $2 AND failed_attempts < $3 AND attempts <= $4 RETURNING attempts", id, now, store.MaxMFAFailures, store.MaxMFAAttempts).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, mapErr(err)
}

func (t *tx) FailMFAChallenge(ctx context.Context, id uuid.UUID) (int, error) {
	var n int
	err := t.q.QueryRow(ctx, "UPDATE iam.mfa_challenges SET failed_attempts = LEAST(failed_attempts + 1, $2) WHERE id = $1 RETURNING failed_attempts", id, store.MaxMFAFailures).Scan(&n)
	return n, mapErr(err)
}

const atCols = "id, owner_type, owner_id, name, secret_hash, created_by, expires_at, last_used_at, revoked_at, created_at"

func scanToken(row pgx.Row) (store.APIToken, error) {
	var tk store.APIToken
	var owner string
	err := row.Scan(&tk.ID, &owner, &tk.OwnerID, &tk.Name, &tk.SecretHash, &tk.CreatedBy, &tk.ExpiresAt, &tk.LastUsedAt, &tk.RevokedAt, &tk.CreatedAt)
	tk.OwnerType = store.OwnerType(owner)
	return tk, mapErr(err)
}

func (t *tx) CreateAPIToken(ctx context.Context, tk store.APIToken) error {
	_, err := t.q.Exec(ctx, "INSERT INTO iam.api_tokens ("+atCols+") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", tk.ID, string(tk.OwnerType), tk.OwnerID, tk.Name, tk.SecretHash, tk.CreatedBy, tk.ExpiresAt, tk.LastUsedAt, tk.RevokedAt, tk.CreatedAt)
	return mapErr(err)
}

func (t *tx) APITokenByID(ctx context.Context, id uuid.UUID) (store.APIToken, error) {
	return scanToken(t.q.QueryRow(ctx, "SELECT "+atCols+" FROM iam.api_tokens WHERE id = $1", id))
}

func (t *tx) ListAPITokens(ctx context.Context, owner store.OwnerType, ownerID uuid.UUID, page store.Page) ([]store.APIToken, int, error) {
	var total int
	if err := t.q.QueryRow(ctx, "SELECT count(*) FROM iam.api_tokens WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL", string(owner), ownerID).Scan(&total); err != nil {
		return nil, 0, mapErr(err)
	}
	lo, args := limitOffset(page, []any{string(owner), ownerID})
	rows, err := t.q.Query(ctx, "SELECT "+atCols+" FROM iam.api_tokens WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL ORDER BY created_at, id"+lo, args...)
	out, err := collect(rows, err, scanToken)
	return out, total, err
}

func (t *tx) RevokeAPIToken(ctx context.Context, id uuid.UUID, owner store.OwnerType, ownerID uuid.UUID, now time.Time) (bool, error) {
	tag, err := t.q.Exec(ctx, "UPDATE iam.api_tokens SET revoked_at = $4 WHERE id = $1 AND owner_type = $2 AND owner_id = $3 AND revoked_at IS NULL", id, string(owner), ownerID, now)
	if err != nil {
		return false, mapErr(err)
	}
	return tag.RowsAffected() == 1, nil
}

func (t *tx) TouchAPIToken(ctx context.Context, id uuid.UUID, now, staleBefore time.Time) error {
	_, err := t.q.Exec(ctx, "UPDATE iam.api_tokens SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)", id, now, staleBefore)
	return mapErr(err)
}

func (t *tx) DeleteAPITokensByOwner(ctx context.Context, owner store.OwnerType, ownerID uuid.UUID) error {
	_, err := t.q.Exec(ctx, "DELETE FROM iam.api_tokens WHERE owner_type = $1 AND owner_id = $2", string(owner), ownerID)
	return mapErr(err)
}

const saCols = "id, org_id, name, description, authz_version, created_by, created_at, updated_at"

func scanSA(row pgx.Row) (store.ServiceAccount, error) {
	var sa store.ServiceAccount
	err := row.Scan(&sa.ID, &sa.OrgID, &sa.Name, &sa.Description, &sa.AuthzVersion, &sa.CreatedBy, &sa.CreatedAt, &sa.UpdatedAt)
	return sa, mapErr(err)
}

func (t *tx) CreateServiceAccount(ctx context.Context, sa store.ServiceAccount) error {
	_, err := t.q.Exec(ctx, "INSERT INTO iam.service_accounts ("+saCols+") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", sa.ID, sa.OrgID, sa.Name, sa.Description, sa.AuthzVersion, sa.CreatedBy, sa.CreatedAt, sa.UpdatedAt)
	return mapErr(err)
}

func (t *tx) ServiceAccountByID(ctx context.Context, id uuid.UUID) (store.ServiceAccount, error) {
	return scanSA(t.q.QueryRow(ctx, "SELECT "+saCols+" FROM iam.service_accounts WHERE id = $1", id))
}

func (t *tx) ServiceAccountsByIDs(ctx context.Context, ids []uuid.UUID) ([]store.ServiceAccount, error) {
	rows, err := t.q.Query(ctx, "SELECT "+saCols+" FROM iam.service_accounts WHERE id = ANY($1) ORDER BY name, id", ids)
	return collect(rows, err, scanSA)
}

func (t *tx) ListServiceAccounts(ctx context.Context, orgID uuid.UUID, only []uuid.UUID, page store.Page) ([]store.ServiceAccount, int, error) {
	where := "org_id = $1"
	args := []any{orgID}
	if only != nil {
		where += " AND id = ANY($2)"
		args = append(args, only)
	}
	var total int
	if err := t.q.QueryRow(ctx, "SELECT count(*) FROM iam.service_accounts WHERE "+where, args...).Scan(&total); err != nil {
		return nil, 0, mapErr(err)
	}
	lo, args := limitOffset(page, args)
	rows, err := t.q.Query(ctx, "SELECT "+saCols+" FROM iam.service_accounts WHERE "+where+" ORDER BY name, id"+lo, args...)
	out, err := collect(rows, err, scanSA)
	return out, total, err
}

func (t *tx) UpdateServiceAccount(ctx context.Context, sa store.ServiceAccount) error {
	tag, err := t.q.Exec(ctx, "UPDATE iam.service_accounts SET name = $2, description = $3, updated_at = $4 WHERE id = $1", sa.ID, sa.Name, sa.Description, sa.UpdatedAt)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteServiceAccount(ctx context.Context, id uuid.UUID) error {
	tag, err := t.q.Exec(ctx, "DELETE FROM iam.service_accounts WHERE id = $1", id)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) ServiceAccountIDsByOrg(ctx context.Context, orgID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := t.q.Query(ctx, "SELECT id FROM iam.service_accounts WHERE org_id = $1 ORDER BY id", orgID)
	return collect(rows, err, func(r pgx.Row) (uuid.UUID, error) {
		var id uuid.UUID
		return id, mapErr(r.Scan(&id))
	})
}

const bindingCols = "id, principal_type, principal_id, resource_type, resource_id, org_id, role, granted_by, created_at"

func scanBinding(row pgx.Row) (store.RoleBinding, error) {
	var b store.RoleBinding
	var ptype, rtype, role string
	if err := row.Scan(&b.ID, &ptype, &b.Principal.ID, &rtype, &b.ResourceID, &b.OrgID, &role, &b.GrantedBy, &b.CreatedAt); err != nil {
		return b, mapErr(err)
	}
	b.Principal.Type = rbac.PrincipalType(ptype)
	b.ResourceType = rbac.ResourceType(rtype)
	r, ok := rbac.ParseRole(role)
	if !ok {
		return b, fmt.Errorf("pgstore: unknown role %q", role)
	}
	b.Role = r
	return b, nil
}

func (t *tx) CreateBinding(ctx context.Context, b store.RoleBinding) error {
	_, err := t.q.Exec(ctx, "INSERT INTO iam.role_bindings ("+bindingCols+") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		b.ID, string(b.Principal.Type), b.Principal.ID, string(b.ResourceType), b.ResourceID, b.OrgID, b.Role.String(), b.GrantedBy, b.CreatedAt)
	return mapErr(err)
}

func (t *tx) BindingByID(ctx context.Context, id uuid.UUID) (store.RoleBinding, error) {
	return scanBinding(t.q.QueryRow(ctx, "SELECT "+bindingCols+" FROM iam.role_bindings WHERE id = $1", id))
}

func (t *tx) BindingFor(ctx context.Context, p store.Principal, rt rbac.ResourceType, resourceID uuid.UUID) (store.RoleBinding, error) {
	return scanBinding(t.q.QueryRow(ctx, "SELECT "+bindingCols+" FROM iam.role_bindings WHERE principal_type = $1 AND principal_id = $2 AND resource_type = $3 AND resource_id = $4",
		string(p.Type), p.ID, string(rt), resourceID))
}

func (t *tx) OrgOwner(ctx context.Context, orgID uuid.UUID, forUpdate bool) (store.RoleBinding, error) {
	q := "SELECT " + bindingCols + " FROM iam.role_bindings WHERE resource_type = 'org' AND resource_id = $1 AND role = 'owner'"
	if forUpdate {
		q += " FOR UPDATE"
	}
	return scanBinding(t.q.QueryRow(ctx, q, orgID))
}

func (t *tx) UpdateBinding(ctx context.Context, b store.RoleBinding) error {
	tag, err := t.q.Exec(ctx, "UPDATE iam.role_bindings SET org_id = $2, role = $3, granted_by = $4, created_at = $5 WHERE id = $1", b.ID, b.OrgID, b.Role.String(), b.GrantedBy, b.CreatedAt)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) DeleteBindings(ctx context.Context, ids []uuid.UUID) ([]store.RoleBinding, error) {
	if len(ids) == 0 {
		return []store.RoleBinding{}, nil
	}
	rows, err := t.q.Query(ctx, "DELETE FROM iam.role_bindings WHERE id = ANY($1) RETURNING "+bindingCols, ids)
	return collect(rows, err, scanBinding)
}

func (t *tx) ListBindings(ctx context.Context, f store.BindingFilter, page store.Page) ([]store.RoleBinding, int, error) {
	var conds []string
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		conds = append(conds, fmt.Sprintf(cond, len(args)))
	}
	if f.Principal != nil {
		add("principal_type = $%d", string(f.Principal.Type))
		add("principal_id = $%d", f.Principal.ID)
	}
	if f.ResourceType != "" {
		add("resource_type = $%d", string(f.ResourceType))
	}
	if f.ResourceID != nil {
		add("resource_id = $%d", *f.ResourceID)
	}
	if f.OrgID != nil {
		add("org_id = $%d", *f.OrgID)
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}
	var total int
	if err := t.q.QueryRow(ctx, "SELECT count(*) FROM iam.role_bindings"+where, args...).Scan(&total); err != nil {
		return nil, 0, mapErr(err)
	}
	lo, args := limitOffset(page, args)
	rows, err := t.q.Query(ctx, "SELECT "+bindingCols+" FROM iam.role_bindings"+where+" ORDER BY created_at, id"+lo, args...)
	out, err := collect(rows, err, scanBinding)
	return out, total, err
}

func (t *tx) ListBindingResources(ctx context.Context, rt rbac.ResourceType, after *store.BindingResourceKey, limit int) ([]store.BindingResource, error) {
	var conds []string
	var args []any
	if rt != "" {
		args = append(args, string(rt))
		conds = append(conds, fmt.Sprintf("resource_type = $%d", len(args)))
	}
	if after != nil {
		args = append(args, string(after.ResourceType), after.ResourceID.String(), after.OrgID.String())
		n := len(args)
		conds = append(conds, fmt.Sprintf(`(resource_type COLLATE "C", resource_id::text COLLATE "C", org_id::text COLLATE "C") > ($%d, $%d, $%d)`, n-2, n-1, n))
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}
	lo, args := limitOffset(store.Page{Limit: limit}, args)
	rows, err := t.q.Query(ctx, "SELECT resource_type, resource_id, org_id, count(*), max(created_at) FROM iam.role_bindings"+where+
		` GROUP BY resource_type, resource_id, org_id ORDER BY resource_type COLLATE "C", resource_id::text COLLATE "C", org_id::text COLLATE "C"`+lo, args...)
	return collect(rows, err, func(r pgx.Row) (store.BindingResource, error) {
		var br store.BindingResource
		var rtype string
		err := r.Scan(&rtype, &br.ResourceID, &br.OrgID, &br.Count, &br.LatestCreatedAt)
		br.ResourceType = rbac.ResourceType(rtype)
		return br, mapErr(err)
	})
}

func (t *tx) ListServiceAccountRefs(ctx context.Context, after *uuid.UUID, limit int) ([]store.ServiceAccount, error) {
	args := []any{}
	where := ""
	if after != nil {
		args = append(args, after.String())
		where = ` WHERE id::text COLLATE "C" > $1`
	}
	lo, args := limitOffset(store.Page{Limit: limit}, args)
	rows, err := t.q.Query(ctx, "SELECT "+saCols+" FROM iam.service_accounts"+where+` ORDER BY id::text COLLATE "C"`+lo, args...)
	return collect(rows, err, scanSA)
}

func (t *tx) Cleanup(ctx context.Context, p store.CleanupPolicy) (store.CleanupResult, error) {
	var r store.CleanupResult
	expired := p.Now.Add(-p.ExpiredRetention)
	revoked := p.Now.Add(-p.RevokedRetention)
	steps := []struct {
		dst  *int64
		sql  string
		args []any
	}{
		{&r.Sessions, "DELETE FROM iam.sessions WHERE expires_at < $1 OR absolute_expires_at < $1 OR revoked_at < $2", []any{expired, revoked}},
		{&r.MFAChallenges, "DELETE FROM iam.mfa_challenges WHERE expires_at < $1 OR used_at < $1", []any{p.Now.Add(-p.MFARetention)}},
		{&r.APITokens, "DELETE FROM iam.api_tokens WHERE expires_at < $1 OR revoked_at < $2", []any{expired, revoked}},
		{&r.RecoveryCodes, "DELETE FROM iam.totp_recovery_codes WHERE used_at < $1", []any{p.Now.Add(-p.RecoveryRetention)}},
	}
	for _, s := range steps {
		tag, err := t.q.Exec(ctx, s.sql, s.args...)
		if err != nil {
			return r, mapErr(err)
		}
		*s.dst = tag.RowsAffected()
	}
	return r, nil
}
