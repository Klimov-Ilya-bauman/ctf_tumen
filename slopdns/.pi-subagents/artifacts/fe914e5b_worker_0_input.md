# Task for worker

[Read from: /Users/anton/CTF/ural_final/slopdns/context.md, /Users/anton/CTF/ural_final/slopdns/plan.md]

Implement approved security fixes in /Users/anton/CTF/ural_final/slopdns, read SECURITY_PLAN.md. You are sole source writer while parent investigates binary and downloads dependencies (parent will not edit source concurrently). Scope web Go source/tests/migrations ONLY; no deploy/DNS binary edits. Confirm and fix: pkg/rbac Roles zone binding upward escalation; backend/core/transfers AcceptTransfer checks highestOwnedOrg instead of targetOrgID (remove unused helper); IAM bindings stale checks allow concurrent promoted owner update/delete (conditional role-protected mutations or safe locks; include trusted revocation; avoid deadlocks); gateway public requests and invalid tokens bypass limiter (bounded preauth per-IP AND global before introspection, keep authenticated principal limits; cap limiter memory and fail closed); IAM atomic DB account-scoped second-factor attempts across fresh MFA challenges and TOTPEnable/Disable/regeneration with temporary cooldown so fresh challenges cannot reset. Preserve API and legitimate flows. Add useful regression tests including PostgreSQL concurrency tests if feasible. Parent handles dependency bootstrap; do not block long on network. Do not commit, no subagents. Return changed files, tests and residual risks. You may add web/pkg/dnsdata strict known-type wire validation for A AAAA GPT/TXT etc if concrete need is established, but coordinate before unrelated expansion.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```