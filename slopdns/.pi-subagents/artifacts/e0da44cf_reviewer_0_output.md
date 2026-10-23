## Review

### Blocker — High: zone permissions escalate to organization and service-account permissions
**Location:** `web/pkg/rbac/rbac.go:196–202`

For any non-zone resource, `Roles()` promotes a zone binding into `orgRole`. Consequently, admin on **one zone** becomes effective admin on its organization and every service account in that organization.

**Exploitation:**
- A zone-only admin passes backend organization authorization at `web/backend/internal/core/core.go:203–205`, including creating invitations (`core/invitations.go:56–57`).
- More directly, they can create an organization-admin binding for themselves through `POST /api/v1/role-bindings`. IAM uses the same broken authorization, accepts zone access as membership, and permits the admin grant (`web/iam/internal/core/bindings.go:248,263–281`). This gives persistent access to all organization zones.

**Fix:** Only apply a zone binding when the target resource is that exact zone. Remove the branch promoting zone roles to organization roles. Keep membership/visibility separate from authorization.

**Regression tests:**
- A zone-only reader/editor/admin must have no organization or unrelated service-account role.
- Zone A permissions must not authorize Zone B operations.
- Zone-only admins cannot invite users or create/update organization bindings.
- Organization roles must continue inheriting downward.

### Blocker — High; Critical when chained: transfer acceptance authorizes the wrong organization
**Location:** `web/backend/internal/core/transfers.go:205–211`

`AcceptTransfer()` checks administration of `highestOwnedOrg(bs)`, **not `targetOrgID`**. The submitted target only needs to exist. The zone is subsequently moved there at line 249.

This contradicts `api/openapi.yaml:3367`, which requires administration of the selected target organization.

**Exploitation:** Two attacker-controlled accounts can transfer their own zone between themselves, accepting into a known victim organization despite neither administering it. Ordinary nesting and quota constraints must still pass.

The transfer outbox explicitly grants the recipient zone-admin in the destination organization, with `ReplaceExisting: true` (`web/backend/internal/outbox/outbox.go:345–350`). Combined with the first finding, this enables **victim organization-admin takeover without victim approval**.

**Fix:** Check `authz.OrgRole(bs, targetOrgID) >= authz.RoleAdmin`; remove `highestOwnedOrg` from this decision. Fix both findings independently.

**Regression tests:**
- Recipient owns Org A but has no role, reader, editor, or zone-only admin in target Org B: acceptance returns 403 and changes neither zone ownership nor bindings/outbox.
- Recipient has an actual target-organization admin/owner binding: acceptance succeeds.
- Two-account cross-organization takeover sequence must fail.

### Correct / scope observations
- No exploitable SQL injection identified in inspected backend store queries: request-controlled values are bound parameters, including zone-name filtering (`web/backend/internal/store/zones.go:68–75`) and record filtering (`store/records.go:71–77`).
- Record parsing checks owner containment, TTL ranges, supported types, and structured data (`web/backend/internal/core/records.go:35–69`). Strict decoding rejects duplicate/unknown fields (`web/backend/internal/rrdata/rrdata.go:229–275`). No additional exploitable parsing defect established.
- No source changes made.

### Validation limitations
- Requested `plan.md` and `progress.md` do not exist.
- Broad backend tests failed during dependency resolution because network downloads were unavailable; generated `web/gen` sources are also absent.
- Standalone RBAC package builds, but reports `[no test files]`. No `*_test.go` files were found under `web`.
- Findings are code-verified; no live HTTP/database exploitation was performed.