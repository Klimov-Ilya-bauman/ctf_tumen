## Review

### Blocker — High: zone permissions escalate to organization permissions
**Location:** `web/pkg/rbac/rbac.go:196–202`.

`Roles` promotes every zone binding into `orgRole` when evaluating an organization **or service account**. A zone administrator therefore becomes an effective organization administrator and administrator of every service account in that organization.

**Exploit:** A user with only zone-admin access can create an organization-admin binding for themselves through `/api/v1/role-bindings`, or mint a token for a more privileged service account through `/api/v1/service-accounts/{id}/tokens` (`web/iam/internal/core/tokens.go:180–198`). This survives removal of the original zone permission.

This contradicts the documented separation between membership and organization roles (`api/openapi.yaml:3227`).

**Fix:** Remove upward inheritance from zone bindings. Zone bindings should affect only the matching zone; retain membership-only visibility separately through `Member`.

**Regression tests:** With only a zone-admin binding, deny organization writes, organization role grants, unrelated service-account reads/token creation, and access to sibling zones. Verify legitimate organization-to-zone inheritance remains functional.

### Blocker — High: concurrent ownership transfer bypasses owner immutability
**Locations:**
- `web/iam/internal/core/bindings.go:335–343,368–375,393–407`
- `web/iam/internal/store/pgstore/pgstore.go:433–434,450–465`
- `web/iam/internal/core/trusted.go:600–625`

Binding reads are unlocked, while subsequent updates/deletes match only the binding ID. Owner protection checks therefore use stale roles.

**Exploitable interleaving:**
1. An organization administrator starts changing/deleting another member’s non-owner organization binding; the owner-protection check passes.
2. Ownership transfer promotes that binding to owner and commits.
3. The administrator’s pending update/delete proceeds, demoting or removing the new owner.

The previous owner has already been demoted, leaving the organization ownerless. The unique-owner index prevents multiple owners, not zero owners.

**Fix:** Lock the target binding before checking its current role and keep the lock through mutation, or use conditional mutations that reject concurrent role changes. Apply equivalent protection to trusted revocation paths. Keep lock ordering consistent with ownership transfer.

**Regression tests:** Use two PostgreSQL transactions and a synchronization barrier to reproduce both PATCH-versus-transfer and DELETE-versus-transfer schedules. Assert the promoted owner cannot be demoted/deleted and exactly one owner remains.

### Note — Medium: MFA guessing limit resets with each password login
**Locations:** `web/iam/internal/core/auth.go:88–104,145–156`; `web/gateway/internal/proxy/proxy.go:162–187`.

Every successful password login creates a fresh challenge with its own five-attempt allowance. Neither password login nor second-factor login traverses the gateway limiter. An attacker knowing the password can repeatedly obtain challenges and continue guessing six-digit TOTP codes without an account-wide failure budget.

The hashing pool limits concurrent password work, not cumulative guesses. This behavior is explicitly documented (`api/openapi.yaml:113`), so it is a security-design weakness rather than a documentation mismatch. Disable/recovery regeneration also lack an MFA-specific failure budget (`web/iam/internal/core/auth.go:473–529`).

**Fix:** Add atomic, temporary account-scoped second-factor throttling shared across challenges and sensitive operations, plus public authentication endpoint throttling. Avoid permanent account lockouts.

**Regression tests:** Exhaust the budget using multiple challenges and concurrent requests; confirm a new challenge does not reset it, other accounts remain unaffected, and access recovers after the cooldown.

### Correct
- Token secrets use cryptographic randomness and constant-time hash comparison (`web/iam/internal/token/token.go:55–61,79–84`).
- TOTP secrets use authenticated encryption; verification advances a replay-protection counter.
- Inspected assertion verification enforces signatures, audience and bounded lifetime. gRPC authorization restricts methods using verified certificate identities (`web/iam/internal/grpcapi/grpcapi.go:30–72`).

### Validation and limitations
- No files edited.
- Requested `plan.md` and `progress.md` were absent.
- Five dependency-light packages compiled successfully, all reporting **no test files**.
- Broader IAM validation timed out during dependency acquisition. Findings are source/SQL-verified, not live exploit demonstrations.