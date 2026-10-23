package outbox

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/authz"
	"slopdns/web/backend/internal/store"
)

const (
	KindCreateOrgOwner = "create_org_owner"
	KindGrant          = "grant"
	KindRevokeResource = "revoke_resource"
	KindZoneTransfer   = "zone_transfer"
)

type Payload struct {
	OrgID           string `json:"org_id,omitempty"`
	UserID          string `json:"user_id,omitempty"`
	PrincipalType   int32  `json:"principal_type,omitempty"`
	PrincipalID     string `json:"principal_id,omitempty"`
	ResourceType    int32  `json:"resource_type,omitempty"`
	ResourceID      string `json:"resource_id,omitempty"`
	ResourceOrgID   string `json:"resource_org_id,omitempty"`
	Role            int32  `json:"role,omitempty"`
	GrantedBy       string `json:"granted_by,omitempty"`
	ReplaceExisting bool   `json:"replace_existing,omitempty"`
	ZoneID          string `json:"zone_id,omitempty"`
	OldOrgID        string `json:"old_org_id,omitempty"`
	NewOrgID        string `json:"new_org_id,omitempty"`
}

func CreateOrgOwner(orgID, userID string) (string, Payload) {
	return KindCreateOrgOwner, Payload{OrgID: orgID, UserID: userID}
}

func Grant(p *iamv1.Principal, r *iamv1.ResourceRef, role iamv1.Role, grantedBy string, replace bool) (string, Payload) {
	return KindGrant, Payload{
		PrincipalType: int32(p.GetType()), PrincipalID: p.GetId(),
		ResourceType: int32(r.GetType()), ResourceID: r.GetId(), ResourceOrgID: r.GetOrgId(),
		Role: int32(role), GrantedBy: grantedBy, ReplaceExisting: replace,
	}
}

func RevokeResource(rtype iamv1.ResourceType, id, orgID string) (string, Payload) {
	return KindRevokeResource, Payload{ResourceType: int32(rtype), ResourceID: id, ResourceOrgID: orgID}
}

func ZoneTransfer(zoneID, oldOrgID, newOrgID, userID string) (string, Payload) {
	return KindZoneTransfer, Payload{ZoneID: zoneID, OldOrgID: oldOrgID, NewOrgID: newOrgID, UserID: userID}
}

func Enqueue(ctx context.Context, q *store.Q, kind string, p Payload) (string, error) {
	data, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return q.EnqueueOutbox(ctx, kind, ResourceKey(kind, p), data)
}

func resourceKey(rtype int32, id string) string {
	switch iamv1.ResourceType(rtype) {
	case iamv1.ResourceType_RESOURCE_TYPE_ORG:
		return "org:" + id
	case iamv1.ResourceType_RESOURCE_TYPE_ZONE:
		return "zone:" + id
	case iamv1.ResourceType_RESOURCE_TYPE_SERVICE_ACCOUNT:
		return "service_account:" + id
	}
	return "unknown:" + id
}

func ResourceKey(kind string, p Payload) string {
	switch kind {
	case KindCreateOrgOwner:
		return "org:" + p.OrgID
	case KindZoneTransfer:
		return "zone:" + p.ZoneID
	}
	return resourceKey(p.ResourceType, p.ResourceID)
}

type permanentError struct {
	err error
}

func (e *permanentError) Error() string {
	return e.err.Error()
}

func (e *permanentError) Unwrap() error {
	return e.err
}

type Dispatcher struct {
	store     *store.Store
	iam       iamv1.IamServiceClient
	logger    *slog.Logger
	now       func() time.Time
	lease     time.Duration
	base      time.Duration
	maxDelay  time.Duration
	timeout   time.Duration
	onApplied func(authz.Principal)
	statsMu   sync.Mutex
	stats     store.OutboxStats
}

const StuckAttempts = 10

func (d *Dispatcher) RefreshStats(ctx context.Context) error {
	st, err := d.store.Q().OutboxStats(ctx, StuckAttempts)
	if err != nil {
		return err
	}
	d.statsMu.Lock()
	d.stats = st
	d.statsMu.Unlock()
	if st.Stuck > 0 || st.Failed > 0 {
		d.logger.WarnContext(ctx, "IAM outbox has stuck or failed entries", slog.Int("stuck", st.Stuck), slog.Int("failed", st.Failed), slog.Int("pending", st.Pending))
	}
	return nil
}

func (d *Dispatcher) Stats() store.OutboxStats {
	d.statsMu.Lock()
	defer d.statsMu.Unlock()
	return d.stats
}

func NewDispatcher(st *store.Store, iam iamv1.IamServiceClient, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{store: st, iam: iam, logger: logger, now: time.Now, lease: 30 * time.Second, base: time.Second, maxDelay: 5 * time.Minute, timeout: 10 * time.Second}
}

func (d *Dispatcher) SetClock(now func() time.Time) {
	d.now = now
}

func (d *Dispatcher) SetBackoff(base, maxDelay time.Duration) {
	d.base, d.maxDelay = base, maxDelay
}

func (d *Dispatcher) OnApplied(f func(authz.Principal)) {
	d.onApplied = f
}

func (d *Dispatcher) Jittered(attempts int) time.Duration {
	b := d.Backoff(attempts)
	half := b / 2
	if half <= 0 {
		return b
	}
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return b
	}
	r := int64(binary.BigEndian.Uint32(buf[:4]))<<30 ^ int64(binary.BigEndian.Uint32(buf[4:]))
	return half + time.Duration(r%int64(half+1))
}

func (d *Dispatcher) Backoff(attempts int) time.Duration {
	delay := d.base
	for i := 1; i < attempts && delay < d.maxDelay; i++ {
		delay *= 2
	}
	if delay > d.maxDelay {
		delay = d.maxDelay
	}
	return delay
}

func (d *Dispatcher) DispatchOne(ctx context.Context, id string) error {
	target, err := d.store.Q().GetOutbox(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	for {
		now := d.now()
		e, err := d.store.Q().ClaimHeadForKey(ctx, target.Key, id, now, now.Add(d.lease))
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := d.process(ctx, e); err != nil {
			return err
		}
		if e.ID == id {
			return nil
		}
	}
}

func (d *Dispatcher) DispatchIDs(ctx context.Context, ids []string) {
	for _, id := range ids {
		if err := d.DispatchOne(ctx, id); err != nil {
			d.logger.WarnContext(ctx, "inline IAM dispatch deferred", slog.String("outbox_id", id), slog.Any("error", err))
		}
	}
}

func (d *Dispatcher) Run(ctx context.Context) error {
	if _, err := d.DispatchDue(ctx, 100); err != nil {
		return err
	}
	return d.RefreshStats(ctx)
}

func (d *Dispatcher) DispatchDue(ctx context.Context, limit int) (int, error) {
	done := 0
	for claimed := 0; claimed < limit; {
		now := d.now()
		entries, err := d.store.Q().ClaimDueOutbox(ctx, now, now.Add(d.lease), limit-claimed)
		if err != nil {
			return done, err
		}
		if len(entries) == 0 {
			return done, nil
		}
		claimed += len(entries)
		progress := 0
		for _, e := range entries {
			if err := d.process(ctx, e); err == nil {
				done++
				progress++
			}
		}
		if progress == 0 {
			return done, nil
		}
	}
	return done, nil
}

func (d *Dispatcher) process(ctx context.Context, e store.OutboxEntry) error {
	var p Payload
	err := json.Unmarshal(e.Payload, &p)
	if err == nil {
		cctx, cancel := context.WithTimeout(ctx, d.timeout)
		err = d.execute(cctx, e.Kind, p)
		cancel()
	} else {
		err = &permanentError{err: err}
	}
	q := d.store.Q()
	now := d.now()
	var pe *permanentError
	switch {
	case err == nil:
		if cerr := q.CompleteOutbox(ctx, e.ID, now); cerr != nil {
			return cerr
		}
		d.applied(e.Kind, p)
		return nil
	case errors.As(err, &pe):
		d.logger.ErrorContext(ctx, "IAM outbox entry failed permanently", slog.String("outbox_id", e.ID), slog.String("kind", e.Kind), slog.Any("error", err))
		if ferr := q.FailOutbox(ctx, e.ID, truncate(err.Error()), now); ferr != nil {
			return ferr
		}
		return err
	default:
		next := now.Add(d.Jittered(e.Attempts))
		d.logger.WarnContext(ctx, "IAM outbox entry will be retried", slog.String("outbox_id", e.ID), slog.String("kind", e.Kind), slog.Int("attempts", e.Attempts), slog.Time("next_attempt_at", next), slog.Any("error", err))
		if rerr := q.RetryOutbox(ctx, e.ID, truncate(err.Error()), next); rerr != nil {
			return rerr
		}
		return err
	}
}

func (d *Dispatcher) applied(kind string, p Payload) {
	if d.onApplied == nil {
		return
	}
	switch kind {
	case KindCreateOrgOwner, KindZoneTransfer:
		d.onApplied(authz.Principal{Type: iamv1.PrincipalType_PRINCIPAL_TYPE_USER, ID: p.UserID})
	case KindGrant:
		d.onApplied(authz.Principal{Type: iamv1.PrincipalType(p.PrincipalType), ID: p.PrincipalID})
	}
}

func truncate(s string) string {
	if len(s) > 1000 {
		return s[:1000]
	}
	return s
}

func classify(err error, okCodes ...codes.Code) error {
	if err == nil {
		return nil
	}
	c := status.Code(err)
	for _, ok := range okCodes {
		if c == ok {
			return nil
		}
	}
	if c == codes.InvalidArgument {
		return &permanentError{err: err}
	}
	return err
}

func (d *Dispatcher) execute(ctx context.Context, kind string, p Payload) error {
	switch kind {
	case KindCreateOrgOwner:
		_, err := d.iam.CreateOrgOwner(ctx, &iamv1.CreateOrgOwnerRequest{OrgId: p.OrgID, UserId: p.UserID})
		return classify(err, codes.AlreadyExists, codes.FailedPrecondition)
	case KindGrant:
		_, err := d.iam.Grant(ctx, &iamv1.GrantRequest{
			Principal:       &iamv1.Principal{Type: iamv1.PrincipalType(p.PrincipalType), Id: p.PrincipalID},
			Resource:        &iamv1.ResourceRef{Type: iamv1.ResourceType(p.ResourceType), Id: p.ResourceID, OrgId: p.ResourceOrgID},
			Role:            iamv1.Role(p.Role),
			GrantedByUserId: p.GrantedBy,
			ReplaceExisting: p.ReplaceExisting,
		})
		return classify(err, codes.AlreadyExists, codes.FailedPrecondition)
	case KindRevokeResource:
		_, err := d.iam.RevokeResource(ctx, &iamv1.RevokeResourceRequest{Resource: &iamv1.ResourceRef{Type: iamv1.ResourceType(p.ResourceType), Id: p.ResourceID, OrgId: p.ResourceOrgID}})
		return classify(err, codes.NotFound)
	case KindZoneTransfer:
		zone := iamv1.ResourceType_RESOURCE_TYPE_ZONE
		if _, err := d.iam.RevokeResource(ctx, &iamv1.RevokeResourceRequest{Resource: &iamv1.ResourceRef{Type: zone, Id: p.ZoneID, OrgId: p.OldOrgID}}); classify(err, codes.NotFound) != nil {
			return classify(err, codes.NotFound)
		}
		_, err := d.iam.Grant(ctx, &iamv1.GrantRequest{
			Principal:       &iamv1.Principal{Type: iamv1.PrincipalType_PRINCIPAL_TYPE_USER, Id: p.UserID},
			Resource:        &iamv1.ResourceRef{Type: zone, Id: p.ZoneID, OrgId: p.NewOrgID},
			Role:            iamv1.Role_ROLE_ADMIN,
			GrantedByUserId: p.UserID,
			ReplaceExisting: true,
		})
		return classify(err, codes.AlreadyExists, codes.FailedPrecondition)
	}
	return &permanentError{err: fmt.Errorf("unknown outbox kind %q", kind)}
}
