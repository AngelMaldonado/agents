#!/usr/bin/env bash
# One-time (idempotent) setup of the dev environment on this Mac: secrets, Postgres cluster,
# CLIProxyAPI binary, and the sandbox network on reko-2. Dev admin PIN: 1234.
set -euo pipefail
. "$(dirname "$0")/env.sh"

mkdir -p "$DEV/logs" "$DEV/server" "$(dirname "$CLIPROXY_CONFIG")"

if [ ! -f "$ENV_FILE" ]; then
	(umask 077; printf 'AGENTS_ADMIN_PIN=1234\nAGENTS_MASTER_KEY=%s\nAGENTS_PROXY_KEY=%s\n' \
		"$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > "$ENV_FILE")
	echo "created .env.dev"
fi
chmod 600 "$ENV_FILE"

if [ ! -f "$PG_DATA/PG_VERSION" ]; then
	command -v initdb >/dev/null || { echo "initdb not found: brew install postgresql@18" >&2; exit 1; }
	# Local trust auth on 127.0.0.1 only: a throwaway dev cluster, like the old dev container.
	initdb -D "$PG_DATA" -U agents --auth=trust --encoding=UTF8 --locale=C >/dev/null
	pg_ctl -D "$PG_DATA" -l "$DEV/logs/pg-init.log" -w \
		-o "-p $PG_PORT -k $DEV -c listen_addresses=127.0.0.1" start >/dev/null
	createdb -h 127.0.0.1 -p "$PG_PORT" -U agents agents
	createdb -h 127.0.0.1 -p "$PG_PORT" -U agents agents_test
	pg_ctl -D "$PG_DATA" -w stop >/dev/null
	echo "created Postgres cluster at data/dev/pg (port $PG_PORT)"
fi

if [ ! -x "$CLIPROXY_BIN" ]; then
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	tarball="CLIProxyAPI_${CLIPROXY_VERSION}_darwin_aarch64.tar.gz"
	curl -fsSL --retry 3 -o "$tmp/$tarball" \
		"https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}/${tarball}"
	echo "$CLIPROXY_SHA256  $tmp/$tarball" | shasum -a 256 -c - >/dev/null
	tar -xzf "$tmp/$tarball" -C "$tmp" cli-proxy-api
	mkdir -p "$(dirname "$CLIPROXY_BIN")"
	install -m 0755 "$tmp/cli-proxy-api" "$CLIPROXY_BIN"
	echo "installed CLIProxyAPI $CLIPROXY_VERSION"
fi

docker --context "$SBX_CTX" network inspect "$SBX_NETWORK" >/dev/null 2>&1 ||
	{ docker --context "$SBX_CTX" network create "$SBX_NETWORK" >/dev/null && echo "created network $SBX_NETWORK on $SBX_CTX"; }

docker --context "$SBX_CTX" image inspect "$SBX_IMAGE" >/dev/null 2>&1 ||
	echo "warning: $SBX_IMAGE is not on $SBX_CTX yet: just sandbox build" >&2
