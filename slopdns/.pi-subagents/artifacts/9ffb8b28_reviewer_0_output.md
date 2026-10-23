## Review
- Correct: Original late service-account lock expansion is closed. `trusted.go:491,518` passes an explicitly nonnil lock set, including when empty. `serviceaccounts.go:237–244` rejects newly discovered users before acquiring further locks.
- Correct: `security_test.go:86–95` exercises actual `revokeOrg` with empty and nonempty initial sets. Both focused race tests passed.
- Blocker: None within this recheck.
- Note: Requested `plan.md` and `progress.md` were absent. Full PostgreSQL suite and vet were not independently rerun.