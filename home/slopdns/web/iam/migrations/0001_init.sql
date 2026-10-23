-- +goose Up
CREATE TABLE iam.users (
    id uuid PRIMARY KEY,
    username text NOT NULL,
    password_hash text NOT NULL,
    totp_secret_enc bytea,
    totp_enabled boolean NOT NULL DEFAULT false,
    totp_last_step bigint,
    authz_version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_key UNIQUE (username),
    CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
    CONSTRAINT users_password_hash_not_empty CHECK (length(password_hash) > 0),
    CONSTRAINT users_totp_enabled_requires_secret CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL),
    CONSTRAINT users_totp_last_step_non_negative CHECK (totp_last_step IS NULL OR totp_last_step >= 0),
    CONSTRAINT users_authz_version_non_negative CHECK (authz_version >= 0)
);

CREATE TABLE iam.sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES iam.users (id) ON DELETE CASCADE,
    secret_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CONSTRAINT sessions_secret_hash_sha256 CHECK (length(secret_hash) = 32),
    CONSTRAINT sessions_expiry_order CHECK (expires_at > created_at AND absolute_expires_at > created_at AND expires_at <= absolute_expires_at)
);

CREATE INDEX sessions_user_id_idx ON iam.sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON iam.sessions (expires_at);
CREATE INDEX sessions_absolute_expires_at_idx ON iam.sessions (absolute_expires_at);

CREATE TABLE iam.totp_recovery_codes (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES iam.users (id) ON DELETE CASCADE,
    code_hash bytea NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT totp_recovery_codes_code_hash_sha256 CHECK (length(code_hash) = 32),
    CONSTRAINT totp_recovery_codes_user_code_key UNIQUE (user_id, code_hash)
);

CREATE INDEX totp_recovery_codes_unused_idx ON iam.totp_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE iam.mfa_challenges (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES iam.users (id) ON DELETE CASCADE,
    secret_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    failed_attempts integer NOT NULL DEFAULT 0,
    CONSTRAINT mfa_challenges_secret_hash_sha256 CHECK (length(secret_hash) = 32),
    CONSTRAINT mfa_challenges_failed_attempts_range CHECK (failed_attempts BETWEEN 0 AND 5),
    CONSTRAINT mfa_challenges_expiry_order CHECK (expires_at > created_at)
);

CREATE INDEX mfa_challenges_user_id_idx ON iam.mfa_challenges (user_id);
CREATE INDEX mfa_challenges_expires_at_idx ON iam.mfa_challenges (expires_at);

CREATE TABLE iam.service_accounts (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    authz_version bigint NOT NULL DEFAULT 0,
    created_by uuid NOT NULL REFERENCES iam.users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT service_accounts_org_name_key UNIQUE (org_id, name),
    CONSTRAINT service_accounts_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
    CONSTRAINT service_accounts_description_length CHECK (char_length(description) <= 256),
    CONSTRAINT service_accounts_authz_version_non_negative CHECK (authz_version >= 0)
);

CREATE INDEX service_accounts_org_id_idx ON iam.service_accounts (org_id);

CREATE TABLE iam.api_tokens (
    id uuid PRIMARY KEY,
    owner_type text NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    secret_hash bytea NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT api_tokens_owner_type_valid CHECK (owner_type IN ('user', 'service_account')),
    CONSTRAINT api_tokens_name_length CHECK (char_length(name) BETWEEN 1 AND 64),
    CONSTRAINT api_tokens_secret_hash_sha256 CHECK (length(secret_hash) = 32),
    CONSTRAINT api_tokens_service_account_never_expires CHECK (owner_type = 'user' OR expires_at IS NULL),
    CONSTRAINT api_tokens_expiry_order CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX api_tokens_owner_idx ON iam.api_tokens (owner_type, owner_id);
CREATE INDEX api_tokens_expires_at_idx ON iam.api_tokens (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX api_tokens_revoked_at_idx ON iam.api_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE iam.role_bindings (
    id uuid PRIMARY KEY,
    principal_type text NOT NULL,
    principal_id uuid NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    org_id uuid NOT NULL,
    role text NOT NULL,
    granted_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT role_bindings_principal_type_valid CHECK (principal_type IN ('user', 'service_account')),
    CONSTRAINT role_bindings_resource_type_valid CHECK (resource_type IN ('org', 'zone', 'service_account')),
    CONSTRAINT role_bindings_role_valid CHECK (role IN ('owner', 'admin', 'editor', 'reader')),
    CONSTRAINT role_bindings_owner_only_on_org CHECK (role <> 'owner' OR resource_type = 'org'),
    CONSTRAINT role_bindings_owner_is_user CHECK (role <> 'owner' OR principal_type = 'user'),
    CONSTRAINT role_bindings_org_resource_matches_org CHECK (resource_type <> 'org' OR resource_id = org_id),
    CONSTRAINT role_bindings_principal_resource_key UNIQUE (principal_type, principal_id, resource_type, resource_id)
);

CREATE UNIQUE INDEX role_bindings_single_owner_idx ON iam.role_bindings (resource_id) WHERE resource_type = 'org' AND role = 'owner';
CREATE INDEX role_bindings_org_id_idx ON iam.role_bindings (org_id);
CREATE INDEX role_bindings_resource_idx ON iam.role_bindings (resource_type, resource_id);
CREATE INDEX role_bindings_principal_idx ON iam.role_bindings (principal_type, principal_id);

-- +goose Down
DROP TABLE iam.role_bindings;
DROP TABLE iam.api_tokens;
DROP TABLE iam.service_accounts;
DROP TABLE iam.mfa_challenges;
DROP TABLE iam.totp_recovery_codes;
DROP TABLE iam.sessions;
DROP TABLE iam.users;
