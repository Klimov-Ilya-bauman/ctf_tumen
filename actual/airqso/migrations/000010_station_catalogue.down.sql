-- Restore the legacy membership representation before removing the new table.
UPDATE broadcasts b SET recipient_snapshot=(
    SELECT COALESCE(jsonb_agg(r.recipient_station_id::text ORDER BY r.recipient_station_id), '[]'::jsonb)
    FROM broadcast_recipients r WHERE r.broadcast_id=b.id
) WHERE snapshot_ready;
DROP INDEX stations_human_created_id_idx;
DROP TABLE broadcast_recipients;
ALTER TABLE broadcasts DROP COLUMN snapshot_ready, DROP COLUMN recipient_count;
