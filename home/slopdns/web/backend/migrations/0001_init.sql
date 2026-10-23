-- +goose Up
CREATE TABLE backend.orgs (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    default_for_user_id uuid,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT orgs_default_for_user_id_key UNIQUE (default_for_user_id),
    CONSTRAINT orgs_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{2,62}$')
);

CREATE INDEX orgs_name_idx ON backend.orgs (name);

CREATE TABLE backend.invitations (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES backend.orgs (id) ON DELETE CASCADE,
    invitee_user_id uuid NOT NULL,
    role text NOT NULL,
    invited_by uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    CONSTRAINT invitations_role_valid CHECK (role IN ('admin', 'editor', 'reader')),
    CONSTRAINT invitations_status_valid CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    CONSTRAINT invitations_expiry_order CHECK (expires_at > created_at),
    CONSTRAINT invitations_decided_when_final CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE UNIQUE INDEX invitations_single_pending_idx ON backend.invitations (org_id, invitee_user_id) WHERE status = 'pending';
CREATE INDEX invitations_invitee_idx ON backend.invitations (invitee_user_id, status);
CREATE INDEX invitations_pending_expiry_idx ON backend.invitations (expires_at) WHERE status = 'pending';

CREATE TABLE backend.zones (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES backend.orgs (id) ON DELETE RESTRICT,
    name text NOT NULL,
    soa_mname text NOT NULL,
    soa_rname text NOT NULL,
    soa_serial bigint NOT NULL DEFAULT 1,
    soa_refresh integer NOT NULL,
    soa_retry integer NOT NULL,
    soa_expire integer NOT NULL,
    soa_minimum integer NOT NULL,
    default_ttl integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT zones_name_key UNIQUE (name),
    CONSTRAINT zones_name_canonical CHECK (name = lower(name) AND name <> '.' AND right(name, 1) = '.' AND octet_length(name) <= 254),
    CONSTRAINT zones_soa_mname_canonical CHECK (soa_mname = lower(soa_mname) AND right(soa_mname, 1) = '.' AND octet_length(soa_mname) <= 254),
    CONSTRAINT zones_soa_rname_canonical CHECK (soa_rname = lower(soa_rname) AND right(soa_rname, 1) = '.' AND octet_length(soa_rname) <= 254),
    CONSTRAINT zones_soa_serial_range CHECK (soa_serial BETWEEN 0 AND 4294967295),
    CONSTRAINT zones_soa_refresh_range CHECK (soa_refresh BETWEEN 60 AND 2147483647),
    CONSTRAINT zones_soa_retry_range CHECK (soa_retry BETWEEN 60 AND 2147483647),
    CONSTRAINT zones_soa_expire_range CHECK (soa_expire BETWEEN 60 AND 2147483647 AND soa_expire > soa_refresh AND soa_expire > soa_retry),
    CONSTRAINT zones_soa_minimum_range CHECK (soa_minimum BETWEEN 0 AND 86400),
    CONSTRAINT zones_default_ttl_range CHECK (default_ttl BETWEEN 0 AND 2147483647)
);

CREATE INDEX zones_org_id_idx ON backend.zones (org_id);

CREATE TABLE backend.records (
    id uuid PRIMARY KEY,
    zone_id uuid NOT NULL REFERENCES backend.zones (id) ON DELETE CASCADE,
    owner text NOT NULL,
    type integer NOT NULL,
    class integer NOT NULL DEFAULT 1,
    ttl integer NOT NULL,
    data jsonb NOT NULL,
    rdata_wire bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT records_owner_canonical CHECK (owner = lower(owner) AND right(owner, 1) = '.' AND octet_length(owner) <= 254),
    CONSTRAINT records_type_range CHECK (type BETWEEN 1 AND 65535 AND type <> 6),
    CONSTRAINT records_class_in CHECK (class = 1),
    CONSTRAINT records_ttl_range CHECK (ttl BETWEEN 0 AND 2147483647),
    CONSTRAINT records_data_is_object CHECK (jsonb_typeof(data) = 'object'),
    CONSTRAINT records_rdata_wire_length CHECK (octet_length(rdata_wire) <= 65535)
);

CREATE INDEX records_zone_owner_type_idx ON backend.records (zone_id, owner, type);
CREATE UNIQUE INDEX records_unique_rr_idx ON backend.records (zone_id, owner, type, sha256(rdata_wire));

CREATE TABLE backend.zone_transfers (
    id uuid PRIMARY KEY,
    zone_id uuid NOT NULL,
    zone_name text NOT NULL,
    from_org_id uuid NOT NULL,
    from_user_id uuid NOT NULL,
    to_user_id uuid NOT NULL,
    target_org_id uuid,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    CONSTRAINT zone_transfers_status_valid CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
    CONSTRAINT zone_transfers_expiry_order CHECK (expires_at > created_at),
    CONSTRAINT zone_transfers_decided_when_final CHECK ((status = 'pending') = (decided_at IS NULL)),
    CONSTRAINT zone_transfers_target_when_accepted CHECK ((status = 'accepted') = (target_org_id IS NOT NULL)),
    CONSTRAINT zone_transfers_target_differs CHECK (target_org_id IS NULL OR target_org_id <> from_org_id)
);

CREATE UNIQUE INDEX zone_transfers_single_pending_idx ON backend.zone_transfers (zone_id) WHERE status = 'pending';
CREATE INDEX zone_transfers_to_user_idx ON backend.zone_transfers (to_user_id, status);
CREATE INDEX zone_transfers_from_org_idx ON backend.zone_transfers (from_org_id, status);
CREATE INDEX zone_transfers_pending_expiry_idx ON backend.zone_transfers (expires_at) WHERE status = 'pending';

CREATE TABLE backend.change_log (
    revision bigserial PRIMARY KEY,
    zone_id uuid NOT NULL,
    ops bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX change_log_created_at_idx ON backend.change_log (created_at);

-- +goose Down
DROP TABLE backend.change_log;
DROP TABLE backend.zone_transfers;
DROP TABLE backend.records;
DROP TABLE backend.zones;
DROP TABLE backend.invitations;
DROP TABLE backend.orgs;
