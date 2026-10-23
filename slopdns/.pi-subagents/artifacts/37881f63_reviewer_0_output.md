## Review

- **Blocker — High:** `web/iam/internal/core/tokens.go:85–110` bypasses the account-wide second-factor budget. `CreateMyToken` reserves only a **session-local** attempt before calling `verifyTOTP`. Consequently, an exhausted account still gets guesses through token creation, multiplied across existing sessions. Commit an account-budget reservation before verification; add exhausted-budget and cross-session regression tests.

- **Note — Medium:** `web/iam/internal/core/trusted.go:475–495` and `web/iam/internal/core/service.go:299–300` permit lock-order inversion. `revokeOrg` locks its initial users, then re-lists bindings and locks newly joined users. If newcomer A sorts before existing B, revocation can hold B→wait A while ownership transfer holds A→wait B. A disposable PostgreSQL reproduction returned **SQLSTATE 40P01**. Restart the transaction when its lock set expands, or use shared organization-level serialization; independently sorting each batch is insufficient.

### Test evidence

With `GOPROXY=off` and the supplied disposable database:
- Full web tests passed.
- IAM/RBAC race tests and vet passed.
- PostgreSQL stale-owner update/delete protection and concurrent account-budget tests passed.
- SQL lock-schedule reproduction confirmed the deadlock above.

### Residual risks

- Existing tests omit token-creation budget coverage and service-level ownership/revocation concurrency.
- Deadlock reproduction exercised the corresponding SQL schedule, not Go entrypoints.
- Requested `plan.md` and `progress.md` were absent; reviewed `SECURITY_PLAN.md`.
- No source files changed.