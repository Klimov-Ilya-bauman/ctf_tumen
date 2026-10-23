# Task for reviewer

[Read from: /Users/anton/CTF/ural_final/slopdns/plan.md, /Users/anton/CTF/ural_final/slopdns/progress.md]

Final read-only security/regression review /Users/anton/CTF/ural_final/slopdns focused on parent new changes: dnssync/session.live now closes stream on DB errors instead of signing freshness heartbeats; security_test validates no heartbeat. deploy compose splits web-edge and dns-link networks to keep public-facing frontend/DNS from DB; optional compose.https.yaml + nginx-https.conf + nginx-realip.conf and frontend include: HTTPS mandatory profile no published frontend, dedicated tls-edge network for real-IP trust; HTTP deliberately retained CTF per user. init_secrets.py generates private unique per-install credentials and refuses overwrite. Check config viability and security. Source originals /tmp/slopdns-original. Do not edit files/no subagents. Report actionable blockers only; note actual tests vs assumptions.

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