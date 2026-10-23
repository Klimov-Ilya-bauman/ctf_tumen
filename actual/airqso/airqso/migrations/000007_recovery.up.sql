CREATE TABLE radio_runtime_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    engine_boot_id char(32) NOT NULL,
    observed_at timestamptz NOT NULL
);
