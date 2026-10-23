package grpcapi

import (
	"context"
	"errors"
	"log/slog"
	"slices"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"
	"slopdns/web/iam/internal/core"
	"slopdns/web/iam/internal/store"
	"slopdns/web/iam/internal/token"
	"slopdns/web/pkg/mtls"
	"slopdns/web/pkg/rbac"
)

var (
	GatewayURI = mtls.ServiceURI("gateway")
	BackendURI = mtls.ServiceURI("backend")
)

func DefaultPolicy() map[string][]string {
	backend := []string{BackendURI}
	return map[string][]string{
		iamv1.IamService_Introspect_FullMethodName:             {GatewayURI},
		iamv1.IamService_Check_FullMethodName:                  backend,
		iamv1.IamService_ListAccessible_FullMethodName:         backend,
		iamv1.IamService_Grant_FullMethodName:                  backend,
		iamv1.IamService_Revoke_FullMethodName:                 backend,
		iamv1.IamService_RevokeResource_FullMethodName:         backend,
		iamv1.IamService_ListBindings_FullMethodName:           backend,
		iamv1.IamService_TransferOwnership_FullMethodName:      backend,
		iamv1.IamService_CreateOrgOwner_FullMethodName:         backend,
		iamv1.IamService_LookupUsers_FullMethodName:            {BackendURI, GatewayURI},
		iamv1.IamService_ListBindingResources_FullMethodName:   backend,
		iamv1.IamService_ListServiceAccountRefs_FullMethodName: backend,
	}
}

func peerURIs(ctx context.Context) []string {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return nil
	}
	info, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok {
		return nil
	}
	leaf, err := mtls.PeerLeaf(&info.State)
	if err != nil {
		return nil
	}
	return mtls.URIs(leaf)
}

func Authorize(policy map[string][]string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		allowed := policy[info.FullMethod]
		for _, u := range peerURIs(ctx) {
			if slices.Contains(allowed, u) {
				return handler(ctx, req)
			}
		}
		return nil, status.Error(codes.PermissionDenied, "peer is not allowed to call this method")
	}
}

func Logging(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		resp, err := handler(ctx, req)
		if status.Code(err) == codes.Internal || status.Code(err) == codes.Unknown {
			logger.ErrorContext(ctx, "grpc call failed", slog.String("method", info.FullMethod), slog.Any("error", err))
		}
		return resp, err
	}
}

type Server struct {
	iamv1.UnimplementedIamServiceServer
	svc *core.Service
	log *slog.Logger
}

func New(svc *core.Service, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Server{svc: svc, log: logger}
}

func toStatus(err error) error {
	if err == nil {
		return nil
	}
	var ce *core.Error
	if !errors.As(err, &ce) {
		return status.Error(codes.Internal, "internal error")
	}
	msg := ce.Error()
	switch ce.Kind {
	case core.KindInvalid:
		return status.Error(codes.InvalidArgument, msg)
	case core.KindNotFound:
		return status.Error(codes.NotFound, msg)
	case core.KindConflict:
		return status.Error(codes.AlreadyExists, msg)
	case core.KindFailedPrecondition:
		return status.Error(codes.FailedPrecondition, msg)
	case core.KindForbidden:
		return status.Error(codes.PermissionDenied, msg)
	case core.KindRateLimited:
		return status.Error(codes.ResourceExhausted, msg)
	case core.KindUnavailable:
		return status.Error(codes.Unavailable, msg)
	case core.KindUnauthenticated, core.KindInvalidCredentials, core.KindMFAInvalid:
		return status.Error(codes.Unauthenticated, msg)
	}
	return status.Error(codes.Internal, "internal error")
}

func invalid(field, msg string) error {
	return status.Error(codes.InvalidArgument, field+": "+msg)
}

func parseID(field, s string) (uuid.UUID, error) {
	id, err := token.ParseID(s)
	if err != nil {
		return uuid.UUID{}, invalid(field, "must be a lower-case canonical UUID")
	}
	return id, nil
}

func parseOptionalID(field, s string) (*uuid.UUID, error) {
	if s == "" {
		return nil, nil
	}
	id, err := parseID(field, s)
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func principalType(t iamv1.PrincipalType) (rbac.PrincipalType, bool) {
	switch t {
	case iamv1.PrincipalType_PRINCIPAL_TYPE_USER:
		return rbac.PrincipalUser, true
	case iamv1.PrincipalType_PRINCIPAL_TYPE_SERVICE_ACCOUNT:
		return rbac.PrincipalServiceAccount, true
	}
	return "", false
}

func principalTypePB(t rbac.PrincipalType) iamv1.PrincipalType {
	if t == rbac.PrincipalServiceAccount {
		return iamv1.PrincipalType_PRINCIPAL_TYPE_SERVICE_ACCOUNT
	}
	return iamv1.PrincipalType_PRINCIPAL_TYPE_USER
}

func resourceType(t iamv1.ResourceType) (rbac.ResourceType, bool) {
	switch t {
	case iamv1.ResourceType_RESOURCE_TYPE_ORG:
		return rbac.ResourceOrg, true
	case iamv1.ResourceType_RESOURCE_TYPE_ZONE:
		return rbac.ResourceZone, true
	case iamv1.ResourceType_RESOURCE_TYPE_SERVICE_ACCOUNT:
		return rbac.ResourceServiceAccount, true
	}
	return "", false
}

func resourceTypePB(t rbac.ResourceType) iamv1.ResourceType {
	switch t {
	case rbac.ResourceOrg:
		return iamv1.ResourceType_RESOURCE_TYPE_ORG
	case rbac.ResourceZone:
		return iamv1.ResourceType_RESOURCE_TYPE_ZONE
	}
	return iamv1.ResourceType_RESOURCE_TYPE_SERVICE_ACCOUNT
}

func rolePB(r rbac.Role) iamv1.Role {
	switch r {
	case rbac.RoleReader:
		return iamv1.Role_ROLE_READER
	case rbac.RoleEditor:
		return iamv1.Role_ROLE_EDITOR
	case rbac.RoleAdmin:
		return iamv1.Role_ROLE_ADMIN
	case rbac.RoleOwner:
		return iamv1.Role_ROLE_OWNER
	}
	return iamv1.Role_ROLE_UNSPECIFIED
}

func roleFromPB(r iamv1.Role) (rbac.Role, bool) {
	switch r {
	case iamv1.Role_ROLE_READER:
		return rbac.RoleReader, true
	case iamv1.Role_ROLE_EDITOR:
		return rbac.RoleEditor, true
	case iamv1.Role_ROLE_ADMIN:
		return rbac.RoleAdmin, true
	case iamv1.Role_ROLE_OWNER:
		return rbac.RoleOwner, true
	}
	return rbac.RoleNone, false
}

func actionFromPB(a iamv1.Action) rbac.Action {
	switch a {
	case iamv1.Action_ACTION_READ:
		return rbac.ActionRead
	case iamv1.Action_ACTION_WRITE:
		return rbac.ActionWrite
	case iamv1.Action_ACTION_MANAGE_ACCESS:
		return rbac.ActionManageAccess
	case iamv1.Action_ACTION_OWN:
		return rbac.ActionOwn
	}
	return rbac.ActionNone
}

func count32(n int) uint32 {
	var out uint32
	for i := 0; i < n && out < 1<<31; i++ {
		out++
	}
	return out
}

func parsePrincipal(field string, p *iamv1.Principal) (store.Principal, error) {
	if p == nil {
		return store.Principal{}, invalid(field, "is required")
	}
	pt, ok := principalType(p.GetType())
	if !ok {
		return store.Principal{}, invalid(field+".type", "is required")
	}
	id, err := parseID(field+".id", p.GetId())
	if err != nil {
		return store.Principal{}, err
	}
	return store.Principal{Type: pt, ID: id}, nil
}

func parseResource(field string, r *iamv1.ResourceRef) (core.ResourceRef, error) {
	if r == nil {
		return core.ResourceRef{}, invalid(field, "is required")
	}
	rt, ok := resourceType(r.GetType())
	if !ok {
		return core.ResourceRef{}, invalid(field+".type", "is required")
	}
	id, err := parseID(field+".id", r.GetId())
	if err != nil {
		return core.ResourceRef{}, err
	}
	org, err := parseOptionalID(field+".org_id", r.GetOrgId())
	if err != nil {
		return core.ResourceRef{}, err
	}
	return core.ResourceRef{Type: rt, ID: id, OrgID: org}, nil
}

func bindingPB(b core.BindingView) *iamv1.RoleBinding {
	out := &iamv1.RoleBinding{
		Id:            b.ID.String(),
		Principal:     &iamv1.Principal{Type: principalTypePB(b.Principal.Type), Id: b.Principal.ID.String()},
		PrincipalName: b.PrincipalName,
		Resource:      &iamv1.ResourceRef{Type: resourceTypePB(b.ResourceType), Id: b.ResourceID.String(), OrgId: b.OrgID.String()},
		Role:          rolePB(b.Role),
		CreatedAt:     timestamppb.New(b.CreatedAt),
	}
	if b.GrantedBy != nil {
		out.GrantedByUserId = b.GrantedBy.String()
	}
	return out
}

func tokenKindPB(k token.Kind) iamv1.TokenKind {
	switch k {
	case token.KindSession:
		return iamv1.TokenKind_TOKEN_KIND_SESSION
	case token.KindUserAPI:
		return iamv1.TokenKind_TOKEN_KIND_USER_API_TOKEN
	case token.KindServiceAccount:
		return iamv1.TokenKind_TOKEN_KIND_SERVICE_ACCOUNT_TOKEN
	}
	return iamv1.TokenKind_TOKEN_KIND_UNSPECIFIED
}

func (s *Server) Introspect(ctx context.Context, req *iamv1.IntrospectRequest) (*iamv1.IntrospectResponse, error) {
	if len(req.GetToken()) > 4*token.MaxLength {
		return &iamv1.IntrospectResponse{}, nil
	}
	in, err := s.svc.Introspect(ctx, req.GetToken())
	if err != nil {
		return nil, toStatus(err)
	}
	if !in.Active {
		return &iamv1.IntrospectResponse{}, nil
	}
	out := &iamv1.IntrospectResponse{
		Active:             true,
		Principal:          &iamv1.Principal{Type: principalTypePB(in.Principal.Type), Id: in.Principal.ID.String()},
		PrincipalName:      in.Name,
		TokenKind:          tokenKindPB(in.Kind),
		Assertion:          in.Assertion,
		AssertionExpiresAt: timestamppb.New(in.AssertionExpires),
		AuthzVersion:       in.AuthzVersion,
	}
	if in.Principal.Type == rbac.PrincipalServiceAccount {
		out.OrgId = in.OrgID.String()
	}
	return out, nil
}

func (s *Server) Check(ctx context.Context, req *iamv1.CheckRequest) (*iamv1.CheckResponse, error) {
	p, err := parsePrincipal("principal", req.GetPrincipal())
	if err != nil {
		return nil, err
	}
	res, err := parseResource("resource", req.GetResource())
	if err != nil {
		return nil, err
	}
	a := actionFromPB(req.GetAction())
	if !a.Valid() {
		return nil, invalid("action", "is required")
	}
	ok, role, err := s.svc.Check(ctx, p, a, res)
	if err != nil {
		return nil, toStatus(err)
	}
	return &iamv1.CheckResponse{Allowed: ok, EffectiveRole: rolePB(role)}, nil
}

func (s *Server) ListAccessible(ctx context.Context, req *iamv1.ListAccessibleRequest) (*iamv1.ListAccessibleResponse, error) {
	p, err := parsePrincipal("principal", req.GetPrincipal())
	if err != nil {
		return nil, err
	}
	rt, ok := resourceType(req.GetResourceType())
	if !ok {
		return nil, invalid("resource_type", "is required")
	}
	acc, err := s.svc.ListAccessible(ctx, p, rt)
	if err != nil {
		return nil, toStatus(err)
	}
	out := &iamv1.ListAccessibleResponse{}
	for _, r := range acc.OrgRoles {
		out.OrgRoles = append(out.OrgRoles, &iamv1.OrgRole{OrgId: r.OrgID.String(), Role: rolePB(r.Role)})
	}
	for _, r := range acc.ResourceRoles {
		out.ResourceRoles = append(out.ResourceRoles, &iamv1.ResourceRole{ResourceId: r.ResourceID.String(), OrgId: r.OrgID.String(), Role: rolePB(r.Role)})
	}
	for _, id := range acc.MemberOrgIDs {
		out.MemberOrgIds = append(out.MemberOrgIds, id.String())
	}
	return out, nil
}

func (s *Server) Grant(ctx context.Context, req *iamv1.GrantRequest) (*iamv1.GrantResponse, error) {
	p, err := parsePrincipal("principal", req.GetPrincipal())
	if err != nil {
		return nil, err
	}
	res, err := parseResource("resource", req.GetResource())
	if err != nil {
		return nil, err
	}
	role, ok := roleFromPB(req.GetRole())
	if !ok {
		return nil, invalid("role", "is required")
	}
	by, err := parseOptionalID("granted_by_user_id", req.GetGrantedByUserId())
	if err != nil {
		return nil, err
	}
	b, created, err := s.svc.Grant(ctx, core.GrantInput{Principal: p, Resource: res, Role: role, GrantedBy: by, ReplaceExisting: req.GetReplaceExisting()})
	if err != nil {
		return nil, toStatus(err)
	}
	return &iamv1.GrantResponse{Binding: bindingPB(b), Created: created}, nil
}

func (s *Server) Revoke(ctx context.Context, req *iamv1.RevokeRequest) (*iamv1.RevokeResponse, error) {
	var n int
	var err error
	switch t := req.GetTarget().(type) {
	case *iamv1.RevokeRequest_BindingId:
		id, perr := parseID("binding_id", t.BindingId)
		if perr != nil {
			return nil, perr
		}
		n, err = s.svc.RevokeBinding(ctx, id)
	case *iamv1.RevokeRequest_PrincipalInOrg:
		p, perr := parsePrincipal("principal_in_org.principal", t.PrincipalInOrg.GetPrincipal())
		if perr != nil {
			return nil, perr
		}
		org, perr := parseID("principal_in_org.org_id", t.PrincipalInOrg.GetOrgId())
		if perr != nil {
			return nil, perr
		}
		n, err = s.svc.RevokePrincipalInOrg(ctx, p, org)
	default:
		return nil, invalid("target", "is required")
	}
	if err != nil {
		return nil, toStatus(err)
	}
	return &iamv1.RevokeResponse{RevokedCount: count32(n)}, nil
}

func (s *Server) RevokeResource(ctx context.Context, req *iamv1.RevokeResourceRequest) (*iamv1.RevokeResourceResponse, error) {
	res, err := parseResource("resource", req.GetResource())
	if err != nil {
		return nil, err
	}
	n, err := s.svc.RevokeResource(ctx, res)
	if err != nil {
		return nil, toStatus(err)
	}
	return &iamv1.RevokeResourceResponse{RevokedCount: count32(n)}, nil
}

func (s *Server) ListBindings(ctx context.Context, req *iamv1.ListBindingsRequest) (*iamv1.ListBindingsResponse, error) {
	var q core.ListBindingsQuery
	switch f := req.GetFilter().(type) {
	case *iamv1.ListBindingsRequest_Resource:
		res, err := parseResource("resource", f.Resource)
		if err != nil {
			return nil, err
		}
		q.Resource = &res
	case *iamv1.ListBindingsRequest_OrgId:
		org, err := parseID("org_id", f.OrgId)
		if err != nil {
			return nil, err
		}
		q.OrgID = &org
	case *iamv1.ListBindingsRequest_Principal:
		p, err := parsePrincipal("principal", f.Principal)
		if err != nil {
			return nil, err
		}
		q.Principal = &p
	default:
		return nil, invalid("filter", "is required")
	}
	res, err := s.svc.ListBindings(ctx, q)
	if err != nil {
		return nil, toStatus(err)
	}
	out := &iamv1.ListBindingsResponse{AuthzVersion: res.AuthzVersion}
	for _, b := range res.Bindings {
		out.Bindings = append(out.Bindings, bindingPB(b))
	}
	return out, nil
}

func (s *Server) TransferOwnership(ctx context.Context, req *iamv1.TransferOwnershipRequest) (*iamv1.TransferOwnershipResponse, error) {
	org, err := parseID("org_id", req.GetOrgId())
	if err != nil {
		return nil, err
	}
	from, err := parseID("from_user_id", req.GetFromUserId())
	if err != nil {
		return nil, err
	}
	to, err := parseID("to_user_id", req.GetToUserId())
	if err != nil {
		return nil, err
	}
	nb, pb, err := s.svc.TransferOwnership(ctx, org, from, to)
	if err != nil {
		return nil, toStatus(err)
	}
	return &iamv1.TransferOwnershipResponse{NewOwnerBinding: bindingPB(nb), PreviousOwnerBinding: bindingPB(pb)}, nil
}

func (s *Server) CreateOrgOwner(ctx context.Context, req *iamv1.CreateOrgOwnerRequest) (*iamv1.CreateOrgOwnerResponse, error) {
	org, err := parseID("org_id", req.GetOrgId())
	if err != nil {
		return nil, err
	}
	user, err := parseID("user_id", req.GetUserId())
	if err != nil {
		return nil, err
	}
	b, created, err := s.svc.CreateOrgOwner(ctx, org, user)
	if err != nil {
		return nil, toStatus(err)
	}
	return &iamv1.CreateOrgOwnerResponse{Binding: bindingPB(b), Created: created}, nil
}

func (s *Server) LookupUsers(ctx context.Context, req *iamv1.LookupUsersRequest) (*iamv1.LookupUsersResponse, error) {
	if len(req.GetUserIds()) > core.MaxLookup || len(req.GetUsernames()) > core.MaxLookup {
		return nil, invalid("user_ids", "at most 1000 ids and 1000 usernames per request")
	}
	ids := make([]uuid.UUID, 0, len(req.GetUserIds()))
	for _, raw := range req.GetUserIds() {
		id, err := parseID("user_ids", raw)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	users, err := s.svc.LookupUsers(ctx, ids, req.GetUsernames())
	if err != nil {
		return nil, toStatus(err)
	}
	out := &iamv1.LookupUsersResponse{}
	for _, u := range users {
		out.Users = append(out.Users, &iamv1.User{Id: u.ID.String(), Username: u.Username})
	}
	return out, nil
}

func (s *Server) ListBindingResources(ctx context.Context, req *iamv1.ListBindingResourcesRequest) (*iamv1.ListBindingResourcesResponse, error) {
	var rt rbac.ResourceType
	if req.GetResourceType() != iamv1.ResourceType_RESOURCE_TYPE_UNSPECIFIED {
		t, ok := resourceType(req.GetResourceType())
		if !ok {
			return nil, invalid("resource_type", "is invalid")
		}
		rt = t
	}
	if req.GetPageSize() > core.MaxListPage {
		return nil, invalid("page_size", "must be between 1 and 1000")
	}
	rs, next, err := s.svc.ListBindingResources(ctx, rt, int(req.GetPageSize()), req.GetPageToken())
	if err != nil {
		return nil, toStatus(err)
	}
	out := &iamv1.ListBindingResourcesResponse{NextPageToken: next}
	for _, r := range rs {
		out.Resources = append(out.Resources, &iamv1.BindingResource{
			Resource:        &iamv1.ResourceRef{Type: resourceTypePB(r.ResourceType), Id: r.ResourceID.String(), OrgId: r.OrgID.String()},
			BindingCount:    count32(r.Count),
			LatestCreatedAt: timestamppb.New(r.LatestCreatedAt),
		})
	}
	return out, nil
}

func (s *Server) ListServiceAccountRefs(ctx context.Context, req *iamv1.ListServiceAccountRefsRequest) (*iamv1.ListServiceAccountRefsResponse, error) {
	if req.GetPageSize() > core.MaxListPage {
		return nil, invalid("page_size", "must be between 1 and 1000")
	}
	sas, next, err := s.svc.ListServiceAccountRefs(ctx, int(req.GetPageSize()), req.GetPageToken())
	if err != nil {
		return nil, toStatus(err)
	}
	out := &iamv1.ListServiceAccountRefsResponse{NextPageToken: next}
	for _, sa := range sas {
		out.ServiceAccounts = append(out.ServiceAccounts, &iamv1.ServiceAccountRef{Id: sa.ID.String(), OrgId: sa.OrgID.String(), CreatedAt: timestamppb.New(sa.CreatedAt)})
	}
	return out, nil
}
