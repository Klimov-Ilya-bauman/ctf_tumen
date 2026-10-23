## Review

Read-only audit completed. Requested `plan.md` and `progress.md` were absent. No files edited.

### Prioritized findings

1. **Blocker — High: default deployment exposes credentials and sessions over plaintext HTTP.**  
   **Evidence:** `deploy/compose.yaml:276–277` publishes HTTP; `web/frontend/nginx.conf:16–17` listens without TLS; `deploy/.env:10` disables secure cookies. Session cookies inherit that setting (`web/iam/internal/httpapi/httpapi.go:234–235`).  
   **Impact:** an on-path attacker can capture passwords, session cookies, API tokens and recovery secrets. HttpOnly and SameSite do not protect transport.  
   **Compatible fix:** terminate TLS at nginx or a trusted ingress, restrict the plaintext listener to that ingress, and set `SESSION_COOKIE_SECURE=true`.

2. **Blocker — High: anonymous authentication traffic bypasses rate limiting.**  
   **Evidence:** login/register/TOTP are public (`web/gateway/internal/proxy/routes.go:38–42`); public requests skip `authenticate` (`proxy.go:162–170`), which contains the only gateway limiter call (`proxy.go:186–188`). nginx has no request-rate limit. Login performs expensive Argon2 verification, including for nonexistent users (`web/iam/internal/core/auth.go:59–86`).  
   **Impact:** unauthenticated requests can monopolize the shared password-hashing pool, denying legitimate authentication. Registration also permits persistent account/database growth. The concurrency cap bounds hashing memory, but does not ensure legitimate availability (`web/iam/internal/password/password.go:105–120`).  
   **Compatible fix:** add bounded pre-authentication per-IP and global limits, plus account-specific login throttling. Retain principal limits for authenticated traffic.

3. **Blocker — High, conditional on reuse: supplied deployment file contains database credentials, including PostgreSQL superuser credentials.**  
   **Evidence:** `deploy/.env:4–9` contains populated passwords; Compose consumes them directly (`deploy/compose.yaml:57–64`). Public-facing frontend and DNS containers also join the database’s shared internal network (`compose.yaml:278–281,318–321`).  
   **Impact:** anyone possessing this distribution already knows the credentials if deployed unchanged. Following a container compromise, database access could cross IAM/backend boundaries instead of respecting application-specific roles. PostgreSQL is not directly published externally.  
   **Compatible fix:** rotate every supplied password, generate unique installation secrets, and distribute placeholders rather than working credentials. Segment database connectivity. Changing `.env` alone does **not** rotate credentials in an existing PostgreSQL volume; update the database roles too.

### Binary availability and audit limitation

- **Note — High assurance gap:** `dns-server/` contains only a stripped Linux x86-64 ELF and its Dockerfile. No C/C++ implementation sources were found. `dns-server/Dockerfile:9` copies the executable without building it.
- Binary SHA-256: `edb04a75de970b9ff1e3ecb5c2201fdcf5ca945543a37751a6ece987bcc3b041`.
- Static inspection confirmed PIE, non-executable stack and GNU RELRO. **No exploitable memory-corruption issue was established.** These mitigations do not establish parser safety.
- **Compatible fix:** obtain the matching source/build provenance and a reproducible build; fuzz DNS parsing, TCP framing, compression pointers and custom GPT records under sanitizers.

### Trust boundaries and verified protections

- **Correct:** internet → nginx → gateway. nginx overwrites client-IP headers and removes inbound assertions (`web/frontend/nginx.conf:133–138`). Gateway enforces canonical paths, replaces assertions, and requires a CSRF header for cookie-authenticated mutations (`web/gateway/internal/proxy/proxy.go:129–195,260–264`).
- **Correct:** DNS node → dns-sync requires mTLS, an allowlisted certificate identity, and a signed hello matching that identity (`web/dnssync/internal/service/service.go:116–128`; `internal/server/server.go:262–292`).
- **Correct:** dns-sync has SELECT grants limited to zones, records and change log (`web/backend/migrations/0002_outbox_and_sync_grants.sql:33–34`).
- **Correct:** frontend secrets use React text rendering rather than raw HTML (`web/frontend/ui/src/components/SecretOnce.tsx:24–28`). CSP restricts scripts and framing (`web/frontend/nginx.conf:39–42`). No raw-HTML injection sink was found in the inspected frontend.
- **Note:** gateway → IAM/backend HTTP and application → PostgreSQL connections are plaintext (`deploy/compose.yaml:135,169,211,245–246`). The shared internal bridge is therefore a consequential trust boundary.
- **Note:** dns-sync deliberately continues signed heartbeats when change-log reads fail (`web/dnssync/internal/server/session.go:271–276,301–303`). Verify whether the binary renews its freshness lease on those heartbeats; otherwise stale records could remain served indefinitely. The binary’s precise behavior was not established. Separate transport liveness from verified database freshness.

### Validation

Compose configuration validation passed. The dependency-free rate-limit package compiled, but has no tests. Focused gateway/dns-sync tests timed out during dependency resolution; generated Go bindings and frontend dependencies are absent. No test files were found in the supplied web tree. No live exploit or binary fuzzing was performed.