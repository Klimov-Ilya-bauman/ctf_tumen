-- +goose Up
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE iam.goose_db_version FROM slopdns_iam;

-- +goose Down
GRANT INSERT, UPDATE, DELETE ON TABLE iam.goose_db_version TO slopdns_iam;
