CREATE TABLE broadcasts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    text varchar(2048) NOT NULL,
    state varchar(16) NOT NULL DEFAULT 'pending',
    attempt_no smallint NOT NULL DEFAULT 0,
    topology_version bigint,
    recipient_snapshot jsonb,
    estimated_duration_ms bigint,
    deadline timestamptz NOT NULL,
    terminal_at timestamptz,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT broadcasts_text CHECK (char_length(text) > 0 AND octet_length(text) <= 2048),
    CONSTRAINT broadcasts_state CHECK (state IN ('pending','queued','transmitting','delivered','failed')),
    CONSTRAINT broadcasts_attempt CHECK (attempt_no BETWEEN 0 AND 2),
    CONSTRAINT broadcasts_topology_version CHECK (topology_version IS NULL OR topology_version > 0),
    CONSTRAINT broadcasts_recipient_snapshot CHECK (recipient_snapshot IS NULL OR jsonb_typeof(recipient_snapshot) = 'array'),
    CONSTRAINT broadcasts_estimated_duration CHECK (estimated_duration_ms IS NULL OR estimated_duration_ms > 0)
);
CREATE INDEX broadcasts_sender_created_idx ON broadcasts (sender_station_id, created_at DESC, id);
CREATE INDEX broadcasts_expiry_idx ON broadcasts (expires_at);

CREATE TABLE broadcast_deliveries (
    broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    recipient_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    delivered_at timestamptz NOT NULL,
    PRIMARY KEY (broadcast_id, recipient_station_id)
);
CREATE INDEX broadcast_deliveries_recipient_created_idx ON broadcast_deliveries (recipient_station_id, delivered_at DESC, broadcast_id);

CREATE TABLE broadcast_outbox (
    broadcast_id uuid PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
    state varchar(16) NOT NULL DEFAULT 'pending',
    attempts smallint NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    last_error_code varchar(64),
    CONSTRAINT broadcast_outbox_state CHECK (state IN ('pending','leased','completed','failed')),
    CONSTRAINT broadcast_outbox_attempts CHECK (attempts BETWEEN 0 AND 2)
);
CREATE INDEX broadcast_outbox_work_idx ON broadcast_outbox (state, available_at, lease_until);
