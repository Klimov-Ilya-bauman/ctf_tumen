ALTER TABLE stations ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE stations
    ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'human',
    ADD CONSTRAINT stations_kind CHECK (kind IN ('human', 'bot')),
    ADD CONSTRAINT stations_owner_kind CHECK (
        (kind = 'human' AND user_id IS NOT NULL) OR
        (kind = 'bot' AND user_id IS NULL)
    );

CREATE INDEX stations_kind_district_idx ON stations (kind, district_id, id);

CREATE TABLE bot_state (
    station_id uuid PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
    scenario varchar(32) NOT NULL DEFAULT 'operator',
    next_action_at timestamptz NOT NULL,
    action_sequence bigint NOT NULL DEFAULT 0,
    version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bot_state_scenario CHECK (scenario IN ('operator')),
    CONSTRAINT bot_state_sequence CHECK (action_sequence >= 0),
    CONSTRAINT bot_state_version CHECK (version > 0)
);

CREATE INDEX bot_state_next_action_idx ON bot_state (next_action_at, station_id);
