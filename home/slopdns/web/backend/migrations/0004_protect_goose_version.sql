-- +goose Up
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE backend.goose_db_version FROM slopdns_backend;

-- +goose Down
GRANT INSERT, UPDATE, DELETE ON TABLE backend.goose_db_version TO slopdns_backend;
