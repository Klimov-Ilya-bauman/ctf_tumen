package grpcapi

import (
	"context"
	"errors"
	"log/slog"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	backendv1 "slopdns/web/gen/slopdns/backend/v1"

	"slopdns/web/backend/internal/core"
)

type Server struct {
	backendv1.UnimplementedBackendServiceServer
	svc    *core.Service
	logger *slog.Logger
}

func New(svc *core.Service, logger *slog.Logger) *Server {
	return &Server{svc: svc, logger: logger}
}

func (s *Server) EnsureDefaultOrg(ctx context.Context, in *backendv1.EnsureDefaultOrgRequest) (*backendv1.EnsureDefaultOrgResponse, error) {
	org, created, err := s.svc.EnsureDefaultOrg(ctx, in.GetUserId(), in.GetUsername())
	if errors.Is(err, core.ErrInvalidArgument) {
		return nil, status.Error(codes.InvalidArgument, "user_id must be a UUID and username must be valid")
	}
	if err != nil {
		s.logger.ErrorContext(ctx, "EnsureDefaultOrg failed", slog.Any("error", err))
		return nil, status.Error(codes.Internal, "internal error")
	}
	return &backendv1.EnsureDefaultOrgResponse{OrgId: org.ID, OrgName: org.Name, Created: created}, nil
}

func (s *Server) GetResourceOrg(ctx context.Context, in *backendv1.GetResourceOrgRequest) (*backendv1.GetResourceOrgResponse, error) {
	var rtype string
	switch in.GetResourceType() {
	case backendv1.OwnedResourceType_OWNED_RESOURCE_TYPE_ORG:
		rtype = "org"
	case backendv1.OwnedResourceType_OWNED_RESOURCE_TYPE_ZONE:
		rtype = "zone"
	default:
		return nil, status.Error(codes.InvalidArgument, "resource_type must be org or zone")
	}
	orgID, err := s.svc.GetResourceOrg(ctx, rtype, in.GetResourceId())
	switch {
	case errors.Is(err, core.ErrInvalidArgument):
		return nil, status.Error(codes.InvalidArgument, "resource_id must be a UUID")
	case errors.Is(err, core.ErrNotFound):
		return nil, status.Error(codes.NotFound, "resource not found")
	case err != nil:
		s.logger.ErrorContext(ctx, "GetResourceOrg failed", slog.Any("error", err))
		return nil, status.Error(codes.Internal, "internal error")
	}
	return &backendv1.GetResourceOrgResponse{OrgId: orgID}, nil
}
