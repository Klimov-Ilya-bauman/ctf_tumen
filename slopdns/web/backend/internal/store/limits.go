package store

import "context"

const ZoneTreeLockKey = int64(0x736c6f707a6f6e65)

func (q *Q) LockZoneTree(ctx context.Context) error {
	_, err := q.db.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, ZoneTreeLockKey)
	return err
}

func (q *Q) LockUserOrgQuota(ctx context.Context, userID string) error {
	_, err := q.db.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('slopdns-org-quota:' || $1, 0))`, userID)
	return err
}

func (q *Q) ForeignNestedZone(ctx context.Context, name string, ancestors []string, orgID, exceptID string) (bool, error) {
	var found bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM backend.zones WHERE org_id <> $3::uuid AND id::text <> $4
		AND (name = ANY($2::text[]) OR right(name, length($1) + 1) = '.' || $1))`, name, ancestors, orgID, exceptID).Scan(&found)
	return found, err
}

func (q *Q) count(ctx context.Context, sql string, args ...any) (int, error) {
	var n int
	err := q.db.QueryRow(ctx, sql, args...).Scan(&n)
	return n, err
}

func (q *Q) CountRecords(ctx context.Context, zoneID string) (int, error) {
	return q.count(ctx, `SELECT count(*) FROM backend.records WHERE zone_id = $1`, zoneID)
}

func (q *Q) CountOrgsCreatedBy(ctx context.Context, userID string) (int, error) {
	return q.count(ctx, `SELECT count(*) FROM backend.orgs WHERE created_by = $1`, userID)
}

func (q *Q) CountPendingInvitations(ctx context.Context, orgID string) (int, error) {
	return q.count(ctx, `SELECT count(*) FROM backend.invitations WHERE org_id = $1 AND status = 'pending'`, orgID)
}

func (q *Q) ZoneWireBytes(ctx context.Context, zoneID, exceptID string) (int64, error) {
	var n int64
	err := q.db.QueryRow(ctx, `SELECT COALESCE(sum(octet_length(rtrim(owner, '.')) + 2 + 10 + octet_length(rdata_wire)), 0) FROM backend.records WHERE zone_id = $1 AND id::text <> $2`, zoneID, exceptID).Scan(&n)
	return n, err
}
