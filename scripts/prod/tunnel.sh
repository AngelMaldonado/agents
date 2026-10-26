#!/usr/bin/env bash
# Forward a local port to the production PostgreSQL: PROD_TUNNEL_PORT when
# `just prod psql` already picked it, else the first free one from
# AGENTS_PROD_TUNNEL_PORT up.
#
# PostgreSQL publishes no host port: it lives only on the stack's private
# Docker network. reko-3 itself can reach that network, so sshd forwards to the
# container's address on it. The address changes whenever Komodo recreates the
# container, so it is resolved again on every reconnect.
set -euo pipefail
# shellcheck source=scripts/prod/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROD_SSH_PUBKEY_FILE=""
trap 'rm -f "$PROD_SSH_PUBKEY_FILE"' EXIT
trap 'exit 130' INT TERM

# Chosen once. A reconnect keeps it, because psql and GUI clients point at it;
# if someone takes it meanwhile, the loop below says who and waits.
port="${PROD_TUNNEL_PORT:-}"
if [ -z "$port" ]; then
  # One tunnel is enough: `just prod psql` may have opened it already.
  if open="$(prod_find_tunnel "$AGENTS_PROD_TUNNEL_PORT")"; then
    echo "[tunnel] already open on 127.0.0.1:${open} (pid $(prod_port_pid "$open")); use that one."
    exit 0
  fi
  port="$(prod_pick_port "$AGENTS_PROD_TUNNEL_PORT")"
fi

prod_ssh_setup

resolve_postgres_ip() {
  # Found by its compose labels: the stack's name and the service. The ssh user is in the docker group.
  "${PROD_SSH[@]}" "$PROD_SSH_TARGET" \
    "c=\$(docker ps --filter 'label=com.docker.compose.project=${AGENTS_PROD_PG_PROJECT}' --filter 'label=com.docker.compose.service=${AGENTS_PROD_PG_SERVICE}' --format '{{.Names}}' | head -n 1) \
     && [ -n \"\$c\" ] \
     && docker inspect -f '{{(index .NetworkSettings.Networks \"${AGENTS_PROD_PG_NETWORK}\").IPAddress}}' \"\$c\""
}

while true; do
  if prod_port_busy "$port"; then
    echo "ERROR: 127.0.0.1:${port} is taken by $(prod_port_owner "$port"). Retrying in 10s (Ctrl-C to stop)." >&2
    sleep 10
    continue
  fi

  status=0
  ip="$(resolve_postgres_ip)" || status=$?
  if [ "$status" -eq 255 ]; then
    echo "ERROR: ssh to ${PROD_SSH_TARGET} failed (key, agent approval or network)." >&2
  elif [ "$status" -ne 0 ] || [ -z "$ip" ]; then
    echo "ERROR: no running ${AGENTS_PROD_PG_SERVICE} container in compose project '${AGENTS_PROD_PG_PROJECT}' on network ${AGENTS_PROD_PG_NETWORK}." >&2
  fi
  if [ "$status" -ne 0 ] || [ -z "$ip" ]; then
    echo "Retrying in 10s (Ctrl-C to stop)." >&2
    sleep 10
    continue
  fi

  echo "[tunnel] 127.0.0.1:${port} → ${AGENTS_PROD_SSH_HOST} → ${ip}:5432"
  "${PROD_SSH[@]}" -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -L "127.0.0.1:${port}:${ip}:5432" \
    "$PROD_SSH_TARGET" || true

  echo "[tunnel] closed; reconnecting in 5s (Ctrl-C to stop)."
  sleep 5
done
