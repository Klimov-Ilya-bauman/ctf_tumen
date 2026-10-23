package rbac

import "errors"

type Role int

const (
	RoleNone Role = iota
	RoleReader
	RoleEditor
	RoleAdmin
	RoleOwner
)

var roleNames = map[Role]string{RoleReader: "reader", RoleEditor: "editor", RoleAdmin: "admin", RoleOwner: "owner"}

func (r Role) String() string {
	if s, ok := roleNames[r]; ok {
		return s
	}
	return ""
}

func (r Role) Valid() bool {
	return r >= RoleReader && r <= RoleOwner
}

func ParseRole(s string) (Role, bool) {
	for r, name := range roleNames {
		if name == s {
			return r, true
		}
	}
	return RoleNone, false
}

func Grantable(r Role) bool {
	return r >= RoleReader && r <= RoleAdmin
}

type Action int

const (
	ActionNone Action = iota
	ActionRead
	ActionWrite
	ActionManageAccess
	ActionOwn
)

func (a Action) Valid() bool {
	return a >= ActionRead && a <= ActionOwn
}

func (a Action) Required() Role {
	switch a {
	case ActionRead:
		return RoleReader
	case ActionWrite:
		return RoleEditor
	case ActionManageAccess:
		return RoleAdmin
	case ActionOwn:
		return RoleOwner
	}
	return RoleOwner + 1
}

type ResourceType string

const (
	ResourceOrg            ResourceType = "org"
	ResourceZone           ResourceType = "zone"
	ResourceServiceAccount ResourceType = "service_account"
)

func (t ResourceType) Valid() bool {
	return t == ResourceOrg || t == ResourceZone || t == ResourceServiceAccount
}

type PrincipalType string

const (
	PrincipalUser           PrincipalType = "user"
	PrincipalServiceAccount PrincipalType = "service_account"
)

func (t PrincipalType) Valid() bool {
	return t == PrincipalUser || t == PrincipalServiceAccount
}

func Max(a, b Role) Role {
	if a > b {
		return a
	}
	return b
}

func Effective(rt ResourceType, orgRole, resourceRole Role) Role {
	if rt == ResourceOrg {
		return orgRole
	}
	return Max(orgRole, resourceRole)
}

func ActionAllowedOn(rt ResourceType, a Action) bool {
	if !a.Valid() || !rt.Valid() {
		return false
	}
	return a != ActionOwn || rt == ResourceOrg
}

func Allowed(rt ResourceType, effective Role, a Action) bool {
	return ActionAllowedOn(rt, a) && effective >= a.Required()
}

func Visible(rt ResourceType, member bool, effective Role) bool {
	if rt == ResourceOrg {
		return member || effective >= RoleReader
	}
	return effective >= RoleReader
}

var (
	ErrNotAllowed       = errors.New("rbac: admin role on the resource is required")
	ErrRoleNotGrantable = errors.New("rbac: role cannot be granted directly")
	ErrOwnerImmutable   = errors.New("rbac: the owner binding can only change through ownership transfer")
	ErrSelfElevation    = errors.New("rbac: a principal cannot raise its own role")
)

type GrantRequest struct {
	CallerEffective Role
	TargetIsCaller  bool
	TargetEffective Role
	ExistingRole    Role
	NewRole         Role
}

func CheckGrant(g GrantRequest) error {
	if !Grantable(g.NewRole) {
		return ErrRoleNotGrantable
	}
	if g.ExistingRole == RoleOwner {
		return ErrOwnerImmutable
	}
	if g.CallerEffective < RoleAdmin {
		return ErrNotAllowed
	}
	if g.TargetIsCaller && g.NewRole > g.CallerEffective {
		return ErrSelfElevation
	}
	if g.NewRole > g.CallerEffective {
		return ErrNotAllowed
	}
	return nil
}

func CheckRevoke(callerEffective, existing Role) error {
	if existing == RoleOwner {
		return ErrOwnerImmutable
	}
	if callerEffective < RoleAdmin {
		return ErrNotAllowed
	}
	return nil
}

type Resource struct {
	Type  ResourceType
	ID    string
	OrgID string
}

type Binding struct {
	ResourceType ResourceType
	ResourceID   string
	OrgID        string
	Role         Role
}

func (r Resource) Valid() bool {
	if !r.Type.Valid() || r.ID == "" || r.OrgID == "" {
		return false
	}
	return r.Type != ResourceOrg || r.ID == r.OrgID
}

func Roles(res Resource, bindings []Binding) (orgRole, resourceRole Role) {
	for _, b := range bindings {
		if b.OrgID != res.OrgID || !b.Role.Valid() {
			continue
		}
		switch {
		case b.ResourceType == ResourceOrg && b.ResourceID == res.OrgID:
			orgRole = Max(orgRole, b.Role)
		case b.ResourceType == ResourceZone:
			if res.Type == ResourceZone {
				if b.ResourceID == res.ID {
					resourceRole = Max(resourceRole, b.Role)
				}
			} else {
				orgRole = Max(orgRole, b.Role)
			}
		case res.Type != ResourceOrg && b.ResourceType == res.Type && b.ResourceID == res.ID:
			resourceRole = Max(resourceRole, b.Role)
		}
	}
	return orgRole, resourceRole
}

func EffectiveRole(res Resource, bindings []Binding) Role {
	if !res.Valid() {
		return RoleNone
	}
	orgRole, resourceRole := Roles(res, bindings)
	return Effective(res.Type, orgRole, resourceRole)
}

func Member(orgID string, bindings []Binding) bool {
	for _, b := range bindings {
		if b.OrgID == orgID && b.Role.Valid() {
			return true
		}
	}
	return false
}

type Decision struct {
	Allowed   bool
	Effective Role
	Visible   bool
}

func Evaluate(res Resource, bindings []Binding, a Action) Decision {
	eff := EffectiveRole(res, bindings)
	return Decision{
		Allowed:   res.Valid() && Allowed(res.Type, eff, a),
		Effective: eff,
		Visible:   res.Valid() && Visible(res.Type, Member(res.OrgID, bindings), eff),
	}
}
