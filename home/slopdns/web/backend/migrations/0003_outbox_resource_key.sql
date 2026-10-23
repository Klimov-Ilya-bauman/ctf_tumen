-- +goose Up
ALTER TABLE backend.iam_outbox ADD COLUMN resource_key text NOT NULL DEFAULT '';

CREATE INDEX iam_outbox_pending_key_idx ON backend.iam_outbox (resource_key, id) WHERE done_at IS NULL AND failed_at IS NULL;

-- +goose Down
DROP INDEX backend.iam_outbox_pending_key_idx;
ALTER TABLE backend.iam_outbox DROP COLUMN resource_key;
