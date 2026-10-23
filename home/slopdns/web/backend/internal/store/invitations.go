package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

const InvitationsPendingKey = "invitations_single_pending_idx"

const (
	StatusPending   = "pending"
	StatusAccepted  = "accepted"
	StatusDeclined  = "declined"
	StatusRevoked   = "revoked"
	StatusExpired   = "expired"
	StatusCancelled = "cancelled"
)

type Invitation struct {
	ID            string
	OrgID         string
	OrgName       string
	InviteeUserID string
	Role          string
	InvitedBy     string
	Status        string
	CreatedAt     time.Time
	ExpiresAt     time.Time
	DecidedAt     *time.Time
}

const invitationColumns = `i.id::text, i.org_id::text, o.name, i.invitee_user_id::text, i.role, i.invited_by::text, i.status, i.created_at, i.expires_at, i.decided_at`

func scanInvitation(row pgx.Row) (Invitation, error) {
	var v Invitation
	err := row.Scan(&v.ID, &v.OrgID, &v.OrgName, &v.InviteeUserID, &v.Role, &v.InvitedBy, &v.Status, &v.CreatedAt, &v.ExpiresAt, &v.DecidedAt)
	return v, mapErr(err)
}

func (q *Q) InsertInvitation(ctx context.Context, v Invitation) (Invitation, error) {
	_, err := q.db.Exec(ctx, `INSERT INTO backend.invitations (id, org_id, invitee_user_id, role, invited_by, status, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
		v.ID, v.OrgID, v.InviteeUserID, v.Role, v.InvitedBy, v.CreatedAt, v.ExpiresAt)
	if err != nil {
		return Invitation{}, mapErr(err)
	}
	return q.GetInvitation(ctx, v.ID)
}

func (q *Q) GetInvitation(ctx context.Context, id string) (Invitation, error) {
	return scanInvitation(q.db.QueryRow(ctx, `SELECT `+invitationColumns+` FROM backend.invitations i JOIN backend.orgs o ON o.id = i.org_id WHERE i.id = $1`, id))
}

func (q *Q) LockInvitation(ctx context.Context, id string) (Invitation, error) {
	return scanInvitation(q.db.QueryRow(ctx, `SELECT `+invitationColumns+` FROM backend.invitations i JOIN backend.orgs o ON o.id = i.org_id WHERE i.id = $1 FOR UPDATE OF i`, id))
}

func (q *Q) DecideInvitation(ctx context.Context, id, status string, at time.Time) error {
	tag, err := q.db.Exec(ctx, `UPDATE backend.invitations SET status = $2, decided_at = $3 WHERE id = $1 AND status = 'pending'`, id, status, at)
	if err != nil {
		return mapErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

func (q *Q) ExpireInvitations(ctx context.Context, now time.Time) (int64, error) {
	tag, err := q.db.Exec(ctx, `UPDATE backend.invitations SET status = 'expired', decided_at = $1 WHERE status = 'pending' AND expires_at <= $1`, now)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

type InvitationFilter struct {
	OrgID     string
	InviteeID string
	Status    string
}

func (q *Q) ListInvitations(ctx context.Context, f InvitationFilter, limit, offset int) ([]Invitation, int, error) {
	where := `($1 = '' OR i.org_id::text = $1) AND ($2 = '' OR i.invitee_user_id::text = $2) AND ($3 = '' OR i.status = $3)`
	var total int
	if err := q.db.QueryRow(ctx, `SELECT count(*) FROM backend.invitations i WHERE `+where, f.OrgID, f.InviteeID, f.Status).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.db.Query(ctx, `SELECT `+invitationColumns+` FROM backend.invitations i JOIN backend.orgs o ON o.id = i.org_id WHERE `+where+` ORDER BY i.created_at DESC, i.id DESC LIMIT $4 OFFSET $5`,
		f.OrgID, f.InviteeID, f.Status, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Invitation, error) { return scanInvitation(r) })
	return out, total, err
}
