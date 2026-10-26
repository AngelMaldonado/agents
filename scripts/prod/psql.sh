#!/usr/bin/env bash
# Interactive psql on the production database, through scripts/prod/tunnel.sh.
#
# Read-only by default: every transaction starts read-only and every statement
# times out after 30s. Writing takes a deliberate, visible act inside the
# session:  SET default_transaction_read_only = off;
#
# The password travels in this process's environment, never on a command line,
# so it shows up neither in `ps` nor in tmux.
set -euo pipefail
# shellcheck source=scripts/prod/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${AGENTS_PROD_PG_PASSWORD:?Set AGENTS_PROD_PG_PASSWORD in .env.production}"

# The port the tunnel window uses (tmux session environment); the configured
# one only for a session started before ports were picked.
port="${PROD_TUNNEL_PORT:-$AGENTS_PROD_TUNNEL_PORT}"

echo "Waiting for the tunnel on 127.0.0.1:${port}..."
for _ in $(seq 1 60); do
  if pg_isready -q -h 127.0.0.1 -p "$port" -t 2; then
    break
  fi
  sleep 1
done
if ! pg_isready -q -h 127.0.0.1 -p "$port" -t 2; then
  echo "ERROR: nothing answers on 127.0.0.1:${port}. Is the tunnel up?" >&2
  exit 1
fi
# A PostgreSQL answering is not enough: another project's tunnel may hold the
# port. Never send the production password to it.
if ! prod_port_is_tunnel "$port"; then
  echo "ERROR: 127.0.0.1:${port} is held by $(prod_port_owner "$port"), not the production tunnel." >&2
  exit 1
fi

export PGPASSWORD="$AGENTS_PROD_PG_PASSWORD"
export PGAPPNAME="${AGENTS_PROD_PG_APPNAME:-agents-prod-psql}"
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30s -c idle_in_transaction_session_timeout=5min"
export PGSSLMODE=disable # the hop is inside SSH; the server has no TLS

exec psql \
  -h 127.0.0.1 -p "$port" \
  -U "$AGENTS_PROD_PG_USER" -d "$AGENTS_PROD_PG_DB" \
  -v ON_ERROR_STOP=0 \
  -v PROMPT1='%[%033[1;41;37m%] PROD %[%033[0m%] %n@%/%R%x%# ' \
  -v PROMPT2='%[%033[1;41;37m%] PROD %[%033[0m%] %R%x%# ' \
  -P pager=off \
  "$@"
