# Task for reviewer

[Read from: /Users/anton/CTF/ural_final/slopdns/plan.md, /Users/anton/CTF/ural_final/slopdns/progress.md]

Read-only final recheck ONLY of last issue from reviewer 52009acf in /Users/anton/CTF/ural_final/slopdns. Parent changed revokeOrg -> deleteServiceAccountWithLocks(ctx,tx,sa,locked); locked is explicitly nonnil even for empty initial set. serviceaccounts.go rejects any newly discovered user in own/onSA bindings before deleteAndBump; standalone delete helper gets nil (no prior locks). Added TestOrgRevocationRejectsLateServiceAccountUserLocks covering both initial empty/nonempty sets through real revokeOrg. Full -race suite with PG and vet passed. Inspect concrete code and test, report if original late SA lock expansion is closed or any blocker remains. No other broad audit/no source edits/no subagents.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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