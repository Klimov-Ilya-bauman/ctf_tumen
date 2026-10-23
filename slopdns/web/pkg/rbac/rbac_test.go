package rbac

import "testing"

func TestResourceRolesDoNotEscalate(t *testing.T) {
	for _, role := range []Role{RoleReader, RoleEditor, RoleAdmin} {
		bindings := []Binding{{ResourceType: ResourceZone, ResourceID: "zone", OrgID: "org", Role: role}}
		for _, res := range []Resource{
			{Type: ResourceOrg, ID: "org", OrgID: "org"},
			{Type: ResourceServiceAccount, ID: "sa", OrgID: "org"},
			{Type: ResourceZone, ID: "other", OrgID: "org"},
			{Type: ResourceZone, ID: "zone", OrgID: "other-org"},
		} {
			if got := EffectiveRole(res, bindings); got != RoleNone {
				t.Fatalf("zone %s escalated to %+v: %s", role, res, got)
			}
		}
		res := Resource{Type: ResourceZone, ID: "zone", OrgID: "org"}
		if got := EffectiveRole(res, bindings); got != role {
			t.Fatalf("zone role lost: %v", got)
		}
		if !Member("org", bindings) {
			t.Fatal("zone member lost organization visibility")
		}
	}
}

func TestOrganizationInheritance(t *testing.T) {
	for _, rt := range []ResourceType{ResourceOrg, ResourceZone, ResourceServiceAccount} {
		id := "resource"
		if rt == ResourceOrg {
			id = "org"
		}
		res := Resource{Type: rt, ID: id, OrgID: "org"}
		bindings := []Binding{{ResourceType: ResourceOrg, ResourceID: "org", OrgID: "org", Role: RoleAdmin}}
		if got := EffectiveRole(res, bindings); got != RoleAdmin {
			t.Fatalf("%s inherited %s", rt, got)
		}
		if !Evaluate(res, bindings, ActionManageAccess).Allowed {
			t.Fatalf("%s lost legitimate access", rt)
		}
	}
}
