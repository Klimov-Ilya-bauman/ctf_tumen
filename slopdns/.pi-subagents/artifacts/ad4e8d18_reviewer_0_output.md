## Review

- **Correct:** RBAC now restricts resource roles to matching type, ID and organization while preserving organization inheritance (`web/pkg/rbac/rbac.go:188–208`). Transfer acceptance checks the actual destination organization (`web/backend/internal/core/transfers.go:190`).
- **Correct:** Both preauthentication budgets execute before public upstream requests or introspection (`web/gateway/internal/proxy/proxy.go:165–183`). Bucket counts are capped without resetting active budgets (`web/gateway/internal/ratelimit/ratelimit.go:60–66`).
- **Correct:** Trusting `X-Real-IP` matches the reviewed deployment: nginx overwrites it (`web/frontend/nginx.conf:133`), and the gateway has no published port in `deploy/compose.yaml`.

- **Note — Medium, availability:** `web/gateway/internal/proxy/proxy.go:166–172` consumes the global budget **before** rejecting an exhausted IP. One client can therefore exhaust the shared budget using requests already denied by its own limit. Deterministic example with IP burst 1/global burst 2: A succeeds; A is IP-limited but consumes the second global token; unrelated B receives 429. Check the IP budget first and add this cross-client regression test.

- **Note — Important missing regression:** `web/backend/internal/authz/authz_test.go:8–19` tests `OrgRole`, not `AcceptTransfer`. Reintroducing the original erroneous `highestOwnedOrg` call would still pass this test. Add a backend transfer test proving ownership of organization A cannot authorize transfer into B, asserting the transfer and zone remain unchanged; also cover legitimate destination admin acceptance.
- **Note — Missing integration coverage:** Current gateway tests call `serve` directly. Add coverage through `New` and the actual reverse proxy, plus nginx verification that spoofed/duplicate `X-Real-IP` values are overwritten. Explicit `/auth/login/totp` prelimit coverage is also absent.

**Validation:** Offline full Go tests, scoped race tests and scoped vet passed. PostgreSQL integration tests skipped because `SLOPDNS_TEST_DATABASE_URL` was unset. No source edits. Requested `plan.md`/`progress.md` were absent; reviewed `SECURITY_PLAN.md`. Deliberate CTF HTTP is not flagged.