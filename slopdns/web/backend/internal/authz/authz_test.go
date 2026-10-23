package authz

import (
	"slopdns/web/pkg/rbac"
	"testing"
)

func TestTargetOrganizationRoleIsNotAnyOwnedOrganization(t *testing.T) {
	bindings := []Binding{
		{ResourceType: rbac.ResourceOrg, ResourceID: "owned", OrgID: "owned", Role: RoleOwner},
		{ResourceType: rbac.ResourceZone, ResourceID: "target-zone", OrgID: "target", Role: RoleAdmin},
	}
	if got := OrgRole(bindings, "target"); got >= RoleAdmin {
		t.Fatalf("unrelated ownership or zone role authorized target organization: %s", got)
	}
	bindings = append(bindings, Binding{ResourceType: rbac.ResourceOrg, ResourceID: "target", OrgID: "target", Role: RoleAdmin})
	if got := OrgRole(bindings, "target"); got != RoleAdmin {
		t.Fatalf("legitimate target admin rejected: %s", got)
	}
}
