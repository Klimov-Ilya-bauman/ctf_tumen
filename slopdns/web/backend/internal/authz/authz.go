package authz

import (
	"container/list"
	"context"
	"sync"
	"time"

	iamv1 "slopdns/web/gen/slopdns/iam/v1"

	"slopdns/web/backend/internal/conv"
	"slopdns/web/pkg/rbac"
)

type Role = rbac.Role

const (
	RoleNone   = rbac.RoleNone
	RoleReader = rbac.RoleReader
	RoleEditor = rbac.RoleEditor
	RoleAdmin  = rbac.RoleAdmin
	RoleOwner  = rbac.RoleOwner
)

type Action = rbac.Action

const (
	ActionRead         = rbac.ActionRead
	ActionWrite        = rbac.ActionWrite
	ActionManageAccess = rbac.ActionManageAccess
	ActionOwn          = rbac.ActionOwn
)

type Principal struct {
	Type    iamv1.PrincipalType
	ID      string
	Version int64
}

func (p Principal) Proto() *iamv1.Principal {
	return &iamv1.Principal{Type: p.Type, Id: p.ID}
}

func (p Principal) IsUser() bool {
	return p.Type == iamv1.PrincipalType_PRINCIPAL_TYPE_USER
}

func (p Principal) key() string {
	return p.Type.String() + ":" + p.ID
}

type Binding struct {
	ID           string
	ResourceType rbac.ResourceType
	ResourceID   string
	OrgID        string
	Role         Role
}

func resourceType(t iamv1.ResourceType) rbac.ResourceType {
	switch t {
	case iamv1.ResourceType_RESOURCE_TYPE_ORG:
		return rbac.ResourceOrg
	case iamv1.ResourceType_RESOURCE_TYPE_ZONE:
		return rbac.ResourceZone
	case iamv1.ResourceType_RESOURCE_TYPE_SERVICE_ACCOUNT:
		return rbac.ResourceServiceAccount
	}
	return ""
}

func FromProto(b *iamv1.RoleBinding) Binding {
	r := b.GetResource()
	role := Role(b.GetRole())
	if !role.Valid() {
		role = RoleNone
	}
	return Binding{ID: b.GetId(), ResourceType: resourceType(r.GetType()), ResourceID: r.GetId(), OrgID: r.GetOrgId(), Role: role}
}

type Authorizer interface {
	Bindings(ctx context.Context, p Principal) ([]Binding, error)
	Invalidate(p Principal)
}

type entry struct {
	key       string
	version   int64
	fetchedAt time.Time
	bindings  []Binding
}

type Cache struct {
	client  iamv1.IamServiceClient
	ttl     time.Duration
	size    int
	now     func() time.Time
	mu      sync.Mutex
	order   *list.List
	entries map[string]*list.Element
	fetches int
}

const (
	DefaultTTL  = 5 * time.Minute
	DefaultSize = 10000
)

func NewCache(client iamv1.IamServiceClient, ttl time.Duration, size int) *Cache {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if size <= 0 {
		size = DefaultSize
	}
	return &Cache{client: client, ttl: ttl, size: size, now: time.Now, order: list.New(), entries: map[string]*list.Element{}}
}

func (c *Cache) SetClock(now func() time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
}

func (c *Cache) Fetches() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fetches
}

func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

func (c *Cache) lookup(p Principal) ([]Binding, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[p.key()]
	if !ok {
		return nil, false
	}
	e := el.Value.(*entry)
	if p.Version == 0 || e.version != p.Version || c.now().Sub(e.fetchedAt) >= c.ttl {
		return nil, false
	}
	c.order.MoveToFront(el)
	return e.bindings, true
}

func (c *Cache) store(p Principal, bindings []Binding) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := p.key()
	if el, ok := c.entries[k]; ok {
		e := el.Value.(*entry)
		e.version, e.fetchedAt, e.bindings = p.Version, c.now(), bindings
		c.order.MoveToFront(el)
		return
	}
	c.entries[k] = c.order.PushFront(&entry{key: k, version: p.Version, fetchedAt: c.now(), bindings: bindings})
	for c.order.Len() > c.size {
		last := c.order.Back()
		c.order.Remove(last)
		delete(c.entries, last.Value.(*entry).key)
	}
}

func (c *Cache) Invalidate(p Principal) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[p.key()]; ok {
		c.order.Remove(el)
		delete(c.entries, p.key())
	}
}

func (c *Cache) Bindings(ctx context.Context, p Principal) ([]Binding, error) {
	if bs, ok := c.lookup(p); ok {
		return bs, nil
	}
	resp, err := c.client.ListBindings(ctx, &iamv1.ListBindingsRequest{Filter: &iamv1.ListBindingsRequest_Principal{Principal: p.Proto()}})
	if err != nil {
		return nil, err
	}
	bs := make([]Binding, 0, len(resp.GetBindings()))
	for _, b := range resp.GetBindings() {
		if b.GetPrincipal().GetType() != p.Type || b.GetPrincipal().GetId() != p.ID {
			continue
		}
		bs = append(bs, FromProto(b))
	}
	c.mu.Lock()
	c.fetches++
	c.mu.Unlock()
	stored := p
	if v := resp.GetAuthzVersion(); v > stored.Version {
		stored.Version = v
	}
	c.store(stored, bs)
	return bs, nil
}

func toRBAC(bs []Binding) []rbac.Binding {
	out := make([]rbac.Binding, 0, len(bs))
	for _, b := range bs {
		out = append(out, rbac.Binding{ResourceType: b.ResourceType, ResourceID: b.ResourceID, OrgID: b.OrgID, Role: b.Role})
	}
	return out
}

func OrgRole(bs []Binding, orgID string) Role {
	return rbac.EffectiveRole(rbac.Resource{Type: rbac.ResourceOrg, ID: orgID, OrgID: orgID}, toRBAC(bs))
}

func ZoneRole(bs []Binding, zoneID, zoneOrgID string) Role {
	role := rbac.EffectiveRole(rbac.Resource{Type: rbac.ResourceZone, ID: zoneID, OrgID: zoneOrgID}, toRBAC(bs))
	if role == RoleOwner && OrgRole(bs, zoneOrgID) != RoleOwner {
		return RoleAdmin
	}
	return role
}

func AllowedOrg(role Role, a Action) bool {
	return rbac.Allowed(rbac.ResourceOrg, role, a)
}

func AllowedZone(role Role, a Action) bool {
	return rbac.Allowed(rbac.ResourceZone, role, a)
}

func ZoneBindings(bs []Binding) []Binding {
	var out []Binding
	for _, b := range bs {
		if b.ResourceType == rbac.ResourceZone && b.Role.Valid() {
			out = append(out, b)
		}
	}
	return out
}

func OrgBindings(bs []Binding) []Binding {
	var out []Binding
	for _, b := range bs {
		if b.ResourceType == rbac.ResourceOrg && b.ResourceID == b.OrgID && b.Role.Valid() {
			out = append(out, b)
		}
	}
	return out
}

func ServiceAccountOrgs(bs []Binding) []string {
	var out []string
	for _, b := range bs {
		if b.ResourceType == rbac.ResourceServiceAccount && b.Role.Valid() {
			out = append(out, b.OrgID)
		}
	}
	return out
}

func RoleName(r Role) string {
	return r.String()
}

func ParseGrantable(s string) (Role, bool) {
	r, ok := rbac.ParseRole(s)
	if !ok || !rbac.Grantable(r) {
		return RoleNone, false
	}
	return r, true
}

func ProtoRole(r Role) iamv1.Role {
	return iamv1.Role(conv.I32(int64(r)))
}

var _ Authorizer = (*Cache)(nil)
