-- +goose Up
ALTER TABLE iam.users
    ADD COLUMN second_factor_attempts integer NOT NULL DEFAULT 0 CHECK (second_factor_attempts >= 0),
    ADD COLUMN second_factor_window_ends_at timestamptz NOT NULL DEFAULT '-infinity';

-- +goose Down
ALTER TABLE iam.users
    DROP COLUMN second_factor_attempts,
    DROP COLUMN second_factor_window_ends_at;
