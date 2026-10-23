package reconcile

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/store"
)

const (
	TypeOrg            = "org"
	TypeZone           = "zone"
	TypeServiceAccount = "service_account"
	DefaultGrace       = 10 * time.Minute
	DefaultWindow      = 30 * 24 * time.Hour
	DefaultPageSize    = 500
	MaxPageSize        = 1000
)

var errStuckCursor = errors.New("iam returned the same page token twice")

type Ref struct {
	ResourceType string
	ResourceID   string
	OrgID        string
	CreatedAt    time.Time
}

type Source interface {
	Refs(ctx context.Context, yield func(Ref) error) error
}

type Reconciler struct {
	store  *store.Store
	iam    iamv1.IamServiceClient
	source Source
	logger *slog.Logger
	now    func() time.Time
	window time.Duration
	grace  time.Duration
}

type Result struct {
	Refs        int
	Revocations int
	Skipped     int
}

func New(st *store.Store, iam iamv1.IamServiceClient, logger *slog.Logger) *Reconciler {
	return &Reconciler{store: st, iam: iam, source: NewIAMSource(iam, DefaultPageSize), logger: logger, now: time.Now, window: DefaultWindow, grace: DefaultGrace}
}

func (r *Reconciler) SetClock(now func() time.Time) {
	r.now = now
}

func (r *Reconciler) SetGrace(d time.Duration) {
	r.grace = d
}

func (r *Reconciler) SetSource(s Source) {
	r.source = s
}

func (r *Reconciler) Run(ctx context.Context) error {
	_, err := r.RunOnce(ctx)
	return err
}

type zoneKey struct {
	zone string
	org  string
}

func (r *Reconciler) RunOnce(ctx context.Context) (Result, error) {
	var res Result
	cutoff := r.now().Add(-r.grace)
	var refs []Ref
	err := r.source.Refs(ctx, func(ref Ref) error {
		res.Refs++
		if !ref.CreatedAt.IsZero() && ref.CreatedAt.After(cutoff) {
			res.Skipped++
			return nil
		}
		refs = append(refs, ref)
		return nil
	})
	if err != nil {
		return res, err
	}
	var orgIDs, zoneIDs []string
	for _, ref := range refs {
		orgIDs = append(orgIDs, ref.OrgID)
		if ref.ResourceType == TypeZone {
			zoneIDs = append(zoneIDs, ref.ResourceID)
		}
	}
	q := r.store.Q()
	orgs, err := q.ExistingOrgs(ctx, orgIDs)
	if err != nil {
		return res, err
	}
	zones, err := q.ZoneOrgs(ctx, zoneIDs)
	if err != nil {
		return res, err
	}
	revokedOrgs := map[string]bool{}
	revokedZones := map[zoneKey]bool{}
	revoke := func(ref *iamv1.ResourceRef) error {
		if _, err := r.iam.RevokeResource(ctx, &iamv1.RevokeResourceRequest{Resource: ref}); err != nil {
			return err
		}
		res.Revocations++
		return nil
	}
	for _, ref := range refs {
		switch ref.ResourceType {
		case TypeOrg, TypeServiceAccount:
			if orgs[ref.OrgID] || revokedOrgs[ref.OrgID] {
				continue
			}
			revokedOrgs[ref.OrgID] = true
			if err := revoke(&iamv1.ResourceRef{Type: iamv1.ResourceType_RESOURCE_TYPE_ORG, Id: ref.OrgID, OrgId: ref.OrgID}); err != nil {
				return res, err
			}
		case TypeZone:
			current, alive := zones[ref.ResourceID]
			if alive && current == ref.OrgID {
				continue
			}
			k := zoneKey{zone: ref.ResourceID}
			if alive {
				k.org = ref.OrgID
			}
			if revokedZones[k] || revokedZones[zoneKey{zone: ref.ResourceID}] {
				continue
			}
			revokedZones[k] = true
			if err := revoke(&iamv1.ResourceRef{Type: iamv1.ResourceType_RESOURCE_TYPE_ZONE, Id: ref.ResourceID, OrgId: k.org}); err != nil {
				return res, err
			}
		}
	}
	if _, err := q.PruneTombstones(ctx, r.now().Add(-r.window)); err != nil {
		return res, err
	}
	if res.Revocations > 0 {
		r.logger.InfoContext(ctx, "reconciler removed orphaned IAM bindings", slog.Int("revocations", res.Revocations), slog.Int("refs", res.Refs))
	}
	return res, nil
}

type IAMSource struct {
	iam      iamv1.IamServiceClient
	pageSize uint32
}

func NewIAMSource(iam iamv1.IamServiceClient, pageSize uint32) *IAMSource {
	if pageSize == 0 || pageSize > MaxPageSize {
		pageSize = DefaultPageSize
	}
	return &IAMSource{iam: iam, pageSize: pageSize}
}

func refType(t iamv1.ResourceType) string {
	switch t {
	case iamv1.ResourceType_RESOURCE_TYPE_ORG:
		return TypeOrg
	case iamv1.ResourceType_RESOURCE_TYPE_ZONE:
		return TypeZone
	case iamv1.ResourceType_RESOURCE_TYPE_SERVICE_ACCOUNT:
		return TypeServiceAccount
	}
	return ""
}

func timeOf(ts *timestamppb.Timestamp) time.Time {
	if ts == nil {
		return time.Time{}
	}
	return ts.AsTime()
}

func (s *IAMSource) Refs(ctx context.Context, yield func(Ref) error) error {
	if err := s.bindingResources(ctx, yield); err != nil {
		return err
	}
	return s.serviceAccounts(ctx, yield)
}

func (s *IAMSource) bindingResources(ctx context.Context, yield func(Ref) error) error {
	tok := ""
	for {
		resp, err := s.iam.ListBindingResources(ctx, &iamv1.ListBindingResourcesRequest{PageSize: s.pageSize, PageToken: tok})
		if err != nil {
			return err
		}
		for _, br := range resp.GetResources() {
			r := br.GetResource()
			ref := Ref{ResourceType: refType(r.GetType()), ResourceID: r.GetId(), OrgID: r.GetOrgId(), CreatedAt: timeOf(br.GetLatestCreatedAt())}
			if ref.ResourceType == "" || ref.ResourceID == "" || ref.OrgID == "" {
				continue
			}
			if err := yield(ref); err != nil {
				return err
			}
		}
		if resp.GetNextPageToken() == "" {
			return nil
		}
		if resp.GetNextPageToken() == tok {
			return errStuckCursor
		}
		tok = resp.GetNextPageToken()
	}
}

func (s *IAMSource) serviceAccounts(ctx context.Context, yield func(Ref) error) error {
	tok := ""
	for {
		resp, err := s.iam.ListServiceAccountRefs(ctx, &iamv1.ListServiceAccountRefsRequest{PageSize: s.pageSize, PageToken: tok})
		if err != nil {
			return err
		}
		for _, sa := range resp.GetServiceAccounts() {
			if sa.GetId() == "" || sa.GetOrgId() == "" {
				continue
			}
			if err := yield(Ref{ResourceType: TypeServiceAccount, ResourceID: sa.GetId(), OrgID: sa.GetOrgId(), CreatedAt: timeOf(sa.GetCreatedAt())}); err != nil {
				return err
			}
		}
		if resp.GetNextPageToken() == "" {
			return nil
		}
		if resp.GetNextPageToken() == tok {
			return errStuckCursor
		}
		tok = resp.GetNextPageToken()
	}
}
