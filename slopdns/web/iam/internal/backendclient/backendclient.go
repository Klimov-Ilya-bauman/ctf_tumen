package backendclient

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	backendv1 "slopdns/web/gen/slopdns/backend/v1"
	"slopdns/web/iam/internal/core"
	"slopdns/web/iam/internal/token"
	"slopdns/web/pkg/mtls"
	"slopdns/web/pkg/rbac"
)

type Client struct {
	conn *grpc.ClientConn
	rpc  backendv1.BackendServiceClient
}

func Dial(addr string, m *mtls.Material, opts ...grpc.DialOption) (*Client, error) {
	cfg, err := mtls.ClientConfig(m, "backend", mtls.AllowURIs(mtls.ServiceURI("backend")))
	if err != nil {
		return nil, err
	}
	opts = append([]grpc.DialOption{grpc.WithTransportCredentials(credentials.NewTLS(cfg))}, opts...)
	conn, err := grpc.NewClient(addr, opts...)
	if err != nil {
		return nil, err
	}
	return &Client{conn: conn, rpc: backendv1.NewBackendServiceClient(conn)}, nil
}

func (c *Client) Close() error {
	return c.conn.Close()
}

func (c *Client) State() string {
	return c.conn.GetState().String()
}

func classify(err error) error {
	switch status.Code(err) {
	case codes.NotFound:
		return fmt.Errorf("%w: %w", core.ErrBackendNotFound, err)
	default:
		return fmt.Errorf("%w: %w", core.ErrBackendUnavailable, err)
	}
}

func (c *Client) EnsureDefaultOrg(ctx context.Context, userID uuid.UUID, username string) error {
	if _, err := c.rpc.EnsureDefaultOrg(ctx, &backendv1.EnsureDefaultOrgRequest{UserId: userID.String(), Username: username}); err != nil {
		return classify(err)
	}
	return nil
}

var errBadResponse = errors.New("backend returned an invalid org_id")

func (c *Client) ResourceOrg(ctx context.Context, rt rbac.ResourceType, id uuid.UUID) (uuid.UUID, error) {
	var t backendv1.OwnedResourceType
	switch rt {
	case rbac.ResourceOrg:
		t = backendv1.OwnedResourceType_OWNED_RESOURCE_TYPE_ORG
	case rbac.ResourceZone:
		t = backendv1.OwnedResourceType_OWNED_RESOURCE_TYPE_ZONE
	default:
		return uuid.UUID{}, fmt.Errorf("%w: unsupported resource type %q", core.ErrBackendNotFound, rt)
	}
	res, err := c.rpc.GetResourceOrg(ctx, &backendv1.GetResourceOrgRequest{ResourceType: t, ResourceId: id.String()})
	if err != nil {
		return uuid.UUID{}, classify(err)
	}
	org, err := token.ParseID(res.GetOrgId())
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("%w: %w", core.ErrBackendUnavailable, errBadResponse)
	}
	return org, nil
}
