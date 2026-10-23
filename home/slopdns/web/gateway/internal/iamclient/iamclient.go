package iamclient

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"
	"slopdns/web/pkg/assertion"
	"slopdns/web/pkg/mtls"
)

const DefaultTimeout = 3 * time.Second

var (
	ErrInactive    = errors.New("token is not active")
	ErrUnavailable = errors.New("identity service unavailable")
)

type Identity struct {
	Type      assertion.PrincipalType
	ID        string
	Name      string
	OrgID     string
	Assertion string
}

func (i Identity) Key() string {
	return string(i.Type) + ":" + i.ID
}

type Client struct {
	rpc     iamv1.IamServiceClient
	timeout time.Duration
}

func New(rpc iamv1.IamServiceClient, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &Client{rpc: rpc, timeout: timeout}
}

func Dial(addr, serverName string, m *mtls.Material) (*grpc.ClientConn, error) {
	if serverName == "" {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, fmt.Errorf("iam address: %w", err)
		}
		serverName = host
	}
	tlsCfg, err := mtls.ClientConfig(m, serverName, mtls.AllowURIs(mtls.ServiceURI("iam")))
	if err != nil {
		return nil, err
	}
	return grpc.NewClient(addr, grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)))
}

func (c *Client) Introspect(ctx context.Context, token string) (Identity, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.rpc.Introspect(ctx, &iamv1.IntrospectRequest{Token: token})
	if err != nil {
		switch status.Code(err) {
		case codes.Unauthenticated, codes.InvalidArgument, codes.NotFound:
			return Identity{}, ErrInactive
		}
		return Identity{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if !resp.GetActive() {
		return Identity{}, ErrInactive
	}
	id, err := identityFrom(resp)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return id, nil
}

func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.rpc.Introspect(ctx, &iamv1.IntrospectRequest{})
	if err != nil {
		return err
	}
	if resp.GetActive() {
		return errors.New("empty token reported active")
	}
	return nil
}

func identityFrom(resp *iamv1.IntrospectResponse) (Identity, error) {
	id := Identity{
		ID:        resp.GetPrincipal().GetId(),
		Name:      resp.GetPrincipalName(),
		OrgID:     resp.GetOrgId(),
		Assertion: resp.GetAssertion(),
	}
	switch resp.GetPrincipal().GetType() {
	case iamv1.PrincipalType_PRINCIPAL_TYPE_USER:
		id.Type = assertion.PrincipalUser
	case iamv1.PrincipalType_PRINCIPAL_TYPE_SERVICE_ACCOUNT:
		id.Type = assertion.PrincipalServiceAccount
	default:
		return Identity{}, errors.New("introspection returned no principal type")
	}
	if !validID(id.ID) {
		return Identity{}, errors.New("introspection returned an invalid principal id")
	}
	if !validAssertion(id.Assertion) {
		return Identity{}, errors.New("introspection returned an invalid assertion")
	}
	return id, nil
}

func validID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
}

func validAssertion(s string) bool {
	if s == "" || len(s) > assertion.MaxLength || strings.Count(s, ".") != 2 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' && c != '.' {
			return false
		}
	}
	return true
}
