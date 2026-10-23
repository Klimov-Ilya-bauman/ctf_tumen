ALTER TABLE transmissions
    ADD COLUMN topology_version bigint,
    ADD COLUMN route_snapshot jsonb,
    ADD COLUMN estimated_duration_ms bigint;

ALTER TABLE transmissions
    ADD CONSTRAINT transmissions_topology_version_positive
        CHECK (topology_version IS NULL OR topology_version > 0),
    ADD CONSTRAINT transmissions_estimated_duration_positive
        CHECK (estimated_duration_ms IS NULL OR estimated_duration_ms > 0),
    ADD CONSTRAINT transmissions_route_shape
        CHECK (route_snapshot IS NULL OR jsonb_typeof(route_snapshot) = 'array');
