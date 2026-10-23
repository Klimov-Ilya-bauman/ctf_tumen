#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  printf '%s\n' '.env already exists; leaving credentials unchanged.'
  exit 0
fi
umask 077
# Hex is URL-safe in DATABASE_URL. Do not put arbitrary unescaped passwords there.
(set -C; printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_ADMIN_PASSWORD=%s\nSERVER_PORT=9090\nCOOKIE_SECURE=false\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env)
printf '%s\n' 'Created .env with random database credentials. Configure PUBLIC_ORIGIN and COOKIE_SECURE for HTTPS.'
