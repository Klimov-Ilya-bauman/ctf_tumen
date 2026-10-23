-- Existing installations may still have the old 8–14 minute schedule. Bring
-- each bot's next action closer exactly once, while keeping a short stagger so
-- the radio queue is not hit by all stations at the same instant.
WITH scheduled AS (
    SELECT station_id, row_number() OVER (ORDER BY station_id) AS position
    FROM bot_state
)
UPDATE bot_state AS state
SET next_action_at = LEAST(
        state.next_action_at,
        now() + scheduled.position * interval '3 seconds'
    ),
    version = state.version + 1,
    updated_at = now()
FROM scheduled
WHERE scheduled.station_id = state.station_id;
