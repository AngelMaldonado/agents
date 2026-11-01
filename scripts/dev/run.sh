#!/usr/bin/env bash
# One long-running process of the dev environment; `just dev` runs each in its own tmux window.
#   tunnel   this Mac's data/dev/docker.sock -> reko-2's Colima Docker socket (reconnects)
#   db       the dev Postgres cluster (data/dev/pg, 127.0.0.1:5433)
#   cliproxy CLIProxyAPI with the config the server writes
#   fake     the scripted fake LLM (scripts/fake-llm.ts) and the test webhook receiver
#   server   the backend, bun --watch
#   web      Vite with local HMR, proxying /api, /hooks and /ws to the backend
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$ROOT"
# Also to data/dev/logs/<name>.log, for `just dev logs` (and survives `just dev restart`).
if [ -n "${1:-}" ]; then
	mkdir -p "$DEV/logs"
	exec > >(tee -a "$DEV/logs/$1.log") 2>&1
fi

wait_for() { # what, check...
	local what="$1"; shift
	until "$@"; do echo "waiting for ${what}..."; sleep 2; done
}

case "${1:-}" in
	tunnel)
		while true; do
			rm -f "$DOCKER_SOCK"
			ssh -nNT -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
				-o StreamLocalBindUnlink=yes -L "$DOCKER_SOCK:$SBX_REMOTE_SOCK" "$SBX_SSH" || true
			echo "tunnel to $SBX_SSH dropped $(date +%T); reconnecting in 3 s"
			sleep 3
		done
		;;
	db)
		# A postmaster ignores the SIGHUP tmux sends on kill-session (it reloads): stop any leftover.
		if pg_ctl -D "$PG_DATA" status >/dev/null 2>&1; then pg_ctl -D "$PG_DATA" -m fast -w stop; fi
		exec postgres -D "$PG_DATA" -p "$PG_PORT" -k "$DEV" -c listen_addresses=127.0.0.1
		;;
	cliproxy)
		wait_for "the server to write $CLIPROXY_CONFIG" test -f "$CLIPROXY_CONFIG"
		cd "$(dirname "$CLIPROXY_CONFIG")"
		exec "$CLIPROXY_BIN" -config "$CLIPROXY_CONFIG"
		;;
	fake)
		FAKE_LLM_PORT="$FAKE_LLM_PORT" exec bun scripts/fake-llm.ts
		;;
	server)
		server_env
		wait_for "Postgres on :$PG_PORT" pg_ready
		wait_for "the Docker tunnel to $SBX_SSH" docker_ready
		echo "sandboxes dial $AGENTS_SANDBOX_SERVER_URL; LLM at $AGENTS_CLIPROXY_URL"
		bun install --silent
		cd server
		exec bun --watch src/index.ts
		;;
	web)
		cd web
		exec bun --bun vite --port 5173 --strictPort
		;;
	*)
		echo "usage: scripts/dev/run.sh tunnel|db|cliproxy|fake|server|web" >&2
		exit 2
		;;
esac
