ALTER TABLE transmissions
    DROP CONSTRAINT IF EXISTS transmissions_route_shape,
    DROP CONSTRAINT IF EXISTS transmissions_estimated_duration_positive,
    DROP CONSTRAINT IF EXISTS transmissions_topology_version_positive,
    DROP COLUMN IF EXISTS estimated_duration_ms,
    DROP COLUMN IF EXISTS route_snapshot,
    DROP COLUMN IF EXISTS topology_version;
