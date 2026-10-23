#!/bin/sh
set -eu
# Runs only for a NEW postgres volume. The application owns its schema, but is
# not a cluster superuser and cannot read server files or execute OS programs.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$APP_DB_PASSWORD" --set=ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE neuroslopctf LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER DATABASE neuroslopctf OWNER TO neuroslopctf;
GRANT USAGE, CREATE ON SCHEMA public TO neuroslopctf;
SQL
