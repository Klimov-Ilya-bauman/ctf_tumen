CREATE TABLE qsos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    station_low_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    station_high_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    caller_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    state varchar(16) NOT NULL DEFAULT 'calling',
    version bigint NOT NULL DEFAULT 1,
    pending_action varchar(16),
    pending_actor_id uuid REFERENCES stations(id) ON DELETE RESTRICT,
    call_expires_at timestamptz NOT NULL,
    close_expires_at timestamptz,
    inactive_expires_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT qsos_distinct_pair CHECK (station_low_id <> station_high_id),
    CONSTRAINT qsos_canonical_pair CHECK (station_low_id::text < station_high_id::text),
    CONSTRAINT qsos_caller_participant CHECK (caller_station_id IN (station_low_id, station_high_id)),
    CONSTRAINT qsos_state CHECK (state IN ('calling','active','closing','completed','rejected','aborted','expired')),
    CONSTRAINT qsos_pending_action CHECK (pending_action IS NULL OR pending_action IN ('call','accept','reject','abort','close','confirm','resume')),
    CONSTRAINT qsos_version_positive CHECK (version > 0)
);

CREATE UNIQUE INDEX qsos_one_open_pair_idx ON qsos (station_low_id, station_high_id)
WHERE state IN ('calling','active','closing');
CREATE INDEX qsos_low_created_idx ON qsos (station_low_id, created_at DESC, id);
CREATE INDEX qsos_high_created_idx ON qsos (station_high_id, created_at DESC, id);

CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qso_id uuid NOT NULL REFERENCES qsos(id) ON DELETE RESTRICT,
    sender_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    text varchar(2048) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT messages_nonempty CHECK (char_length(text) > 0 AND octet_length(text) <= 2048)
);
CREATE INDEX messages_qso_created_idx ON messages (qso_id, created_at, id);

CREATE TABLE transmissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qso_id uuid NOT NULL REFERENCES qsos(id) ON DELETE RESTRICT,
    message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
    control_kind varchar(16),
    sender_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    recipient_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    state varchar(16) NOT NULL DEFAULT 'pending',
    attempt_no smallint NOT NULL DEFAULT 0,
    deadline timestamptz NOT NULL,
    terminal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transmissions_content CHECK ((message_id IS NOT NULL) <> (control_kind IS NOT NULL)),
    CONSTRAINT transmissions_control_kind CHECK (control_kind IS NULL OR control_kind IN ('call','accept','reject','abort','close','confirm','resume')),
    CONSTRAINT transmissions_state CHECK (state IN ('pending','queued','transmitting','delivered','failed','cancelled')),
    CONSTRAINT transmissions_attempt CHECK (attempt_no BETWEEN 0 AND 2)
);
CREATE INDEX transmissions_qso_state_idx ON transmissions (qso_id, state);

CREATE TABLE message_deliveries (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    recipient_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    delivered_at timestamptz NOT NULL,
    PRIMARY KEY (message_id, recipient_station_id)
);

CREATE TABLE outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transmission_id uuid NOT NULL UNIQUE REFERENCES transmissions(id) ON DELETE CASCADE,
    state varchar(16) NOT NULL DEFAULT 'pending',
    attempts smallint NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    last_error_code varchar(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT outbox_state CHECK (state IN ('pending','leased','completed','failed')),
    CONSTRAINT outbox_attempts CHECK (attempts BETWEEN 0 AND 2)
);
CREATE INDEX outbox_work_idx ON outbox (state, available_at, lease_until);

CREATE TABLE processed_radio_events (
    event_id uuid PRIMARY KEY,
    transmission_id uuid NOT NULL REFERENCES transmissions(id) ON DELETE CASCADE,
    processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE qso_reports (
    qso_id uuid NOT NULL REFERENCES qsos(id) ON DELETE CASCADE,
    station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    readability smallint NOT NULL CHECK (readability BETWEEN 1 AND 5),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (qso_id, station_id)
);

CREATE TABLE qsl_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qso_id uuid NOT NULL UNIQUE REFERENCES qsos(id) ON DELETE RESTRICT,
    snapshot jsonb NOT NULL,
    template_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
    actor_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    route varchar(128) NOT NULL,
    key varchar(128) NOT NULL,
    request_hash bytea NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (actor_station_id, route, key),
    CONSTRAINT idempotency_key_format CHECK (key ~ '^[A-Za-z0-9._:-]{16,128}$')
);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);
