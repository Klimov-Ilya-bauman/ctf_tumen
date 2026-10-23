-- +goose Up
ALTER TABLE iam.mfa_challenges ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE iam.mfa_challenges ADD CONSTRAINT mfa_challenges_attempts_range CHECK (attempts BETWEEN 0 AND 6);
ALTER TABLE iam.sessions ADD COLUMN totp_failures integer NOT NULL DEFAULT 0;
ALTER TABLE iam.sessions ADD CONSTRAINT sessions_totp_failures_range CHECK (totp_failures BETWEEN 0 AND 5);

-- +goose Down
ALTER TABLE iam.sessions DROP COLUMN totp_failures;
ALTER TABLE iam.mfa_challenges DROP COLUMN attempts;
