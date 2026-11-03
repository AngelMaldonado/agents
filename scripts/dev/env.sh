# Sourced by scripts/dev/*.sh: where the dev environment lives on this Mac and how it reaches reko-2.
# The backend, the web, Postgres and CLIProxyAPI run here; only the sandboxes run on reko-2 (Colima).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV="$ROOT/data/dev"
ENV_FILE="$ROOT/.env.dev" # secrets, created by `just dev init`; gitignored (.env*)

SBX_CTX=reko-2                                        # docker context for the sandboxes
SBX_SSH=reko-2                                        # ssh host for the Docker socket tunnel
SBX_REMOTE_SOCK=/Users/reko/.colima/default/docker.sock
DOCKER_SOCK="$DEV/docker.sock"                        # the tunnel's local end; the server uses it
SBX_NETWORK=agents-dev-sandbox
SBX_IMAGE=agents-sandbox:dev
PROXY_IMAGE=agents-proxy:dev    # the egress proxy of API keys (#24), on reko-2 next to the sandboxes
PROXY_NAME=agents-dev-proxy
PROXY_DIR="$DEV/proxy"          # its dev CA (key + certificate), from just dev init

PG_PORT=5433 # 5432 is usually taken by a Homebrew Postgres of other projects
PG_DATA="$DEV/pg"
DB_URL="postgres://agents:agents@127.0.0.1:$PG_PORT/agents"
TEST_DB_URL="postgres://agents:agents@127.0.0.1:$PG_PORT/agents_test"

CLIPROXY_VERSION=8.0.40 # the same as prod (deploy/komodo.compose.yaml)
CLIPROXY_SHA256=0b4b72f79a1a8d6d37d6c9fe7ee1b0011ebff9a294ed856ec3e7b04b318adc14 # darwin_aarch64 tarball
CLIPROXY_BIN="$ROOT/.tools/cliproxy/$CLIPROXY_VERSION/cli-proxy-api"
CLIPROXY_CONFIG="$DEV/cliproxy/config.yaml" # written by the server on start and on every key change
FAKE_LLM_PORT=8318

SERVER_PORT=8787
WA_PORT=8790 # the WhatsApp bridge
WEB_URL=http://localhost:5173
LLM_MODE_FILE="$DEV/llm" # "fake" or "real" (just dev fake on|off)

PG_BIN=/opt/homebrew/opt/postgresql@18/bin
[ -d "$PG_BIN" ] && PATH="$PG_BIN:$PATH"

# The sandboxes on reko-2 dial the backend here, over the tailnet.
host_ip() {
	if [ -n "${AGENTS_DEV_HOST_IP:-}" ]; then echo "$AGENTS_DEV_HOST_IP"; return; fi
	local ip
	ip="$(tailscale ip -4 2>/dev/null | head -1)"
	[ -n "$ip" ] || { echo "no tailnet IPv4 (tailscale ip -4); set AGENTS_DEV_HOST_IP" >&2; return 1; }
	echo "$ip"
}

# The server's environment: the secrets plus everything that says "this is dev on this Mac".
server_env() {
	[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE: run just dev init" >&2; return 1; }
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
	local llm=real
	[ -f "$LLM_MODE_FILE" ] && llm="$(cat "$LLM_MODE_FILE")"
	export AGENTS_INSTANCE=dev
	export AGENTS_DATA="$DEV/server"
	export AGENTS_CLIPROXY_CONFIG="$CLIPROXY_CONFIG"
	if [ "$llm" = fake ]; then
		export AGENTS_CLIPROXY_URL="http://127.0.0.1:$FAKE_LLM_PORT"
	else
		export AGENTS_CLIPROXY_URL="http://127.0.0.1:8317"
	fi
	export AGENTS_SANDBOX_NETWORK="$SBX_NETWORK"
	export AGENTS_SANDBOX_SERVER_URL="http://$(host_ip):$SERVER_PORT"
	export AGENTS_SANDBOX_IMAGE="$SBX_IMAGE"
	export AGENTS_WEB_DIST=/nonexistent
	export AGENTS_DATABASE_URL="$DB_URL"
	export AGENTS_TEST_DATABASE_URL="$TEST_DB_URL"
	export AGENTS_PUBLIC_URL="$WEB_URL"
	export AGENTS_COOKIE_SECURE=0
	export DOCKER_SOCKET="$DOCKER_SOCK"
	# The egress proxy (#24): sandboxes reach it by name on their network; it asks this backend.
	export AGENTS_PROXY_URL="http://$PROXY_NAME:8080"
	export AGENTS_PROXY_CA_CERT="$(cat "$PROXY_DIR/ca.crt")"
	export PORT="$SERVER_PORT"
	# The WhatsApp bridge (#18) runs on this Mac too: `whatsapp` window; numbers are linked by QR in the web.
	export AGENTS_WHATSAPP_URL="http://127.0.0.1:$WA_PORT"
}

docker_ready() { curl -sf --max-time 3 --unix-socket "$DOCKER_SOCK" http://docker/_ping >/dev/null 2>&1; }
pg_ready() { pg_isready -q -h 127.0.0.1 -p "$PG_PORT" -U agents -d agents; }
