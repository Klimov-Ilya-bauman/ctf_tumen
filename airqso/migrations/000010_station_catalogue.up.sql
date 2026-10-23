-- Frozen broadcast membership lives in PostgreSQL, independently of RDX frames.
ALTER TABLE broadcasts
    ADD COLUMN snapshot_ready boolean NOT NULL DEFAULT false,
    ADD COLUMN recipient_count bigint NOT NULL DEFAULT 0;

CREATE TABLE broadcast_recipients (
    broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    recipient_station_id uuid NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
    distance_squared bigint NOT NULL CHECK (distance_squared >= 0),
    PRIMARY KEY (broadcast_id, recipient_station_id)
);
CREATE INDEX broadcast_recipients_station_idx
    ON broadcast_recipients(recipient_station_id, broadcast_id);

-- Preserve memberships of broadcasts created by the previous release.
INSERT INTO broadcast_recipients(broadcast_id, recipient_station_id, distance_squared)
SELECT b.id, r.id,
    (floor(r.x*1000+0.5)::bigint-floor(sender.x*1000+0.5)::bigint)^2::numeric
    + (floor(r.y*1000+0.5)::bigint-floor(sender.y*1000+0.5)::bigint)^2::numeric
FROM broadcasts b JOIN stations sender ON sender.id=b.sender_station_id
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(b.recipient_snapshot, '[]'::jsonb)) member(id)
JOIN stations r ON r.id=member.id::uuid
ON CONFLICT DO NOTHING;
UPDATE broadcasts b
SET snapshot_ready=true,
    recipient_count=(SELECT count(*) FROM broadcast_recipients r WHERE r.broadcast_id=b.id)
WHERE b.recipient_snapshot IS NOT NULL;

CREATE INDEX stations_human_created_id_idx ON stations(created_at, id) WHERE kind='human';
