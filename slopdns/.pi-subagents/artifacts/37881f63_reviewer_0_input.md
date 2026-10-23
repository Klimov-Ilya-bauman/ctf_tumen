# Task for reviewer

[Read from: /Users/anton/CTF/ural_final/slopdns/plan.md, /Users/anton/CTF/ural_final/slopdns/progress.md]

Read-only independent adversarial review of implemented IAM fixes in /Users/anton/CTF/ural_final/slopdns. Original at /tmp/slopdns-original/web; inspect actual changes in web/iam plus shared rbac. Focus ownership mutation races, lock order/deadlocks and any sibling bypass, account second-factor budget atomicity/coverage. Run tests with GOPROXY=off; generated code exists. Disposable DB postgres://postgres:audit-only-password@127.0.0.1:15432/postgres?sslmode=disable available via SLOPDNS_TEST_DATABASE_URL. Do not edit source or launch agents. Return only actionable issues, tests evidence, residual risks.

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