CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login varchar(50) NOT NULL,
    normalized_login varchar(50) NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_login_length CHECK (char_length(login) BETWEEN 5 AND 50),
    CONSTRAINT users_login_characters CHECK (login ~ '^[A-Za-z0-9_]+$'),
    CONSTRAINT users_normalized_login_format CHECK (normalized_login = lower(login))
);

CREATE UNIQUE INDEX users_normalized_login_key ON users (normalized_login);

CREATE TABLE stations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    callsign char(5) NOT NULL UNIQUE,
    district_id varchar(32) NOT NULL,
    subject_code varchar(16) NOT NULL,
    x double precision NOT NULL,
    y double precision NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stations_callsign_characters CHECK (callsign ~ '^[A-Z0-9]{5}$'),
    CONSTRAINT stations_callsign_has_letter CHECK (callsign ~ '[A-Z]'),
    CONSTRAINT stations_callsign_has_digit CHECK (callsign ~ '[0-9]'),
    CONSTRAINT stations_coordinates CHECK (x >= 0 AND x <= 1000 AND y >= 0 AND y <= 600),
    CONSTRAINT stations_version_positive CHECK (version > 0)
);

CREATE INDEX stations_created_id_idx ON stations (created_at, id);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT sessions_expiry_order CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE login_rate_limits (
    normalized_login varchar(50) PRIMARY KEY,
    window_started_at timestamptz NOT NULL,
    attempts smallint NOT NULL,
    CONSTRAINT login_rate_limits_attempts_positive CHECK (attempts > 0)
);

CREATE INDEX login_rate_limits_window_idx ON login_rate_limits (window_started_at);
