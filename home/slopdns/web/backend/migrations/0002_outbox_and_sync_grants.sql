-- +goose Up
CREATE TABLE backend.iam_outbox (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    done_at timestamptz,
    failed_at timestamptz,
    CONSTRAINT iam_outbox_kind_valid CHECK (kind IN ('create_org_owner', 'grant', 'revoke_resource', 'zone_transfer')),
    CONSTRAINT iam_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT iam_outbox_attempts_range CHECK (attempts >= 0),
    CONSTRAINT iam_outbox_single_outcome CHECK (done_at IS NULL OR failed_at IS NULL)
);

CREATE INDEX iam_outbox_due_idx ON backend.iam_outbox (next_attempt_at, created_at) WHERE done_at IS NULL AND failed_at IS NULL;
CREATE INDEX iam_outbox_finished_idx ON backend.iam_outbox (created_at) WHERE done_at IS NOT NULL OR failed_at IS NOT NULL;

CREATE TABLE backend.deleted_resources (
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    org_id uuid NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (resource_type, resource_id),
    CONSTRAINT deleted_resources_type_valid CHECK (resource_type IN ('org', 'zone'))
);

CREATE INDEX deleted_resources_deleted_at_idx ON backend.deleted_resources (deleted_at);

GRANT USAGE ON SCHEMA backend TO slopdns_sync;
GRANT SELECT ON TABLE backend.zones, backend.records, backend.change_log TO slopdns_sync;

-- +goose Down
REVOKE SELECT ON TABLE backend.zones, backend.records, backend.change_log FROM slopdns_sync;
REVOKE USAGE ON SCHEMA backend FROM slopdns_sync;

DROP TABLE backend.deleted_resources;
DROP TABLE backend.iam_outbox;
