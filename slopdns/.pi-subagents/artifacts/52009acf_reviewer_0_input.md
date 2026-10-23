# Task for reviewer

[Read from: /Users/anton/CTF/ural_final/slopdns/plan.md, /Users/anton/CTF/ural_final/slopdns/progress.md]

Final read-only focused verification in /Users/anton/CTF/ural_final/slopdns: earlier review found account MFA bypass in CreateMyToken and lock-set expansion deadlock in revokeOrg. Parent patched tokens.go to reserve account budget, trusted.go to reject newly expanded user lock-set before deletion, added core/security_test.go. Also reordered proxy preauth to IP before global with cross-client test, added New reverse-proxy test and tools/security_smoke.py. Inspect these final changes for blockers only, run relevant offline tests if useful. Full -race suite with disposable PostgreSQL just passed; smoke API passed. No source edits/subagents. Return concise evidence, no speculative polish.

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