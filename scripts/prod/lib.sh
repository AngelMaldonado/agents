#!/usr/bin/env bash
# Shared by scripts/prod/*.sh: load the production access file and expose the
# values the tunnel and psql need. Sourced, never executed.
#
# The file is the repository root `.env.production`, ignored by git and by the
# Docker build context. Every key is prefixed AGENTS_PROD_ so nothing that loads
# dotenv files on its own (Bun does, with NODE_ENV=production) can mistake it
# for application configuration: it never defines DATABASE_URL.
#
# .env.production.example is the documented template. The keys:
#
#   AGENTS_PROD_SSH_HOST=reko-3                # an ~/.ssh/config alias or a hostname
#   AGENTS_PROD_SSH_USER=                      # optional; empty = what ~/.ssh/config says
#   AGENTS_PROD_SSH_1P_KEY=SHA256:...          # optional: fingerprint or 1Password item title
#   AGENTS_PROD_SSH_1P_SOCK=...                # optional; the platform default below
#   AGENTS_PROD_SSH_KEY=~/.ssh/key             # optional fallback when 1Password is unavailable
#                                              # neither key set = plain ssh with ~/.ssh/config
#   AGENTS_PROD_PG_PROJECT=agents              # the compose project: the Komodo stack's name
#   AGENTS_PROD_PG_SERVICE=postgres
#   AGENTS_PROD_PG_NETWORK=agents-prod-internal
#   AGENTS_PROD_PG_USER=agents
#   AGENTS_PROD_PG_DB=agents
#   AGENTS_PROD_PG_PASSWORD=...                # AGENTS_DB_PASSWORD in the Komodo stack
#   AGENTS_PROD_TUNNEL_PORT=15433              # first port tried; see prod_pick_port
#
# PROD_TUNNEL_PORT (no AGENTS_ prefix, never in the file) is the port actually in
# use. `just prod psql` picks it once and hands it to the tunnel and psql
# windows through the tmux session environment, so both agree on it.

# shellcheck disable=SC2034 # every PROD_* value is consumed by the sourcing script
PROD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROD_ENV_FILE="${AGENTS_PROD_ENV_FILE:-$PROD_ROOT/.env.production}"

if [ ! -f "$PROD_ENV_FILE" ]; then
  echo "ERROR: $PROD_ENV_FILE is missing." >&2
  echo "Create it: cp .env.production.example .env.production && chmod 600 .env.production" >&2
  exit 2
fi

# It holds the production database password: owner-only, or say so.
mode="$(stat -f '%Lp' "$PROD_ENV_FILE" 2>/dev/null || stat -c '%a' "$PROD_ENV_FILE")"
if [ "$mode" != "600" ] && [ "$mode" != "400" ]; then
  echo "WARNING: $PROD_ENV_FILE is mode $mode; run: chmod 600 $PROD_ENV_FILE" >&2
fi

set -a
# shellcheck disable=SC1090
source "$PROD_ENV_FILE"
set +a

: "${AGENTS_PROD_SSH_HOST:?Set AGENTS_PROD_SSH_HOST in .env.production}"
AGENTS_PROD_SSH_USER="${AGENTS_PROD_SSH_USER:-}"
AGENTS_PROD_SSH_KEY="${AGENTS_PROD_SSH_KEY:-}"
AGENTS_PROD_SSH_KEY="${AGENTS_PROD_SSH_KEY/#\~/$HOME}"
AGENTS_PROD_SSH_1P_KEY="${AGENTS_PROD_SSH_1P_KEY:-}"
if [ -z "${AGENTS_PROD_SSH_1P_SOCK:-}" ]; then
  case "$(uname -s)" in
    Darwin) AGENTS_PROD_SSH_1P_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ;;
    *) AGENTS_PROD_SSH_1P_SOCK="$HOME/.1password/agent.sock" ;;
  esac
fi
AGENTS_PROD_SSH_1P_SOCK="${AGENTS_PROD_SSH_1P_SOCK/#\~/$HOME}"
AGENTS_PROD_PG_PROJECT="${AGENTS_PROD_PG_PROJECT:-agents}"
AGENTS_PROD_PG_SERVICE="${AGENTS_PROD_PG_SERVICE:-postgres}"
AGENTS_PROD_PG_NETWORK="${AGENTS_PROD_PG_NETWORK:-agents-prod-internal}"
AGENTS_PROD_PG_USER="${AGENTS_PROD_PG_USER:-agents}"
AGENTS_PROD_PG_DB="${AGENTS_PROD_PG_DB:-agents}"
AGENTS_PROD_TUNNEL_PORT="${AGENTS_PROD_TUNNEL_PORT:-15433}"
PROD_TUNNEL_PORT="${PROD_TUNNEL_PORT:-}"

PROD_SSH_TARGET="${AGENTS_PROD_SSH_USER:+$AGENTS_PROD_SSH_USER@}$AGENTS_PROD_SSH_HOST"

# The pid listening on 127.0.0.1:$1, if lsof can see it.
prod_port_pid() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

# True when something already listens on local port $1. lsof sees listeners on
# any address; the connect attempt covers a missing lsof or another user's
# process.
prod_port_busy() {
  [ -n "$(prod_port_pid "$1")" ] && return 0
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Who holds port $1, for humans: "ssh to ssh://reko-3 (pid 45190)".
prod_port_owner() {
  local pid name
  pid="$(prod_port_pid "$1")"
  if [ -z "$pid" ]; then
    echo "a process lsof cannot see"
    return 0
  fi
  name="$(basename "$(ps -o comm= -p "$pid" 2>/dev/null)")"
  if [ "$name" = ssh ]; then
    # An ssh's last argument is its destination; nothing secret.
    echo "ssh to $(ps -ww -o args= -p "$pid" | awk '{print $NF}') (pid $pid)"
  else
    echo "$name (pid $pid)"
  fi
}

# True when port $1 is held by this repository's production tunnel: an ssh to
# the production host forwarding exactly that port. Without lsof it cannot
# tell, and says yes.
prod_port_is_tunnel() {
  command -v lsof >/dev/null 2>&1 || return 0
  local pid args
  pid="$(prod_port_pid "$1")"
  [ -n "$pid" ] || return 1
  args="$(ps -ww -o args= -p "$pid" 2>/dev/null)"
  [[ "$args" == *"127.0.0.1:$1:"* && "$args" == *"$PROD_SSH_TARGET"* ]]
}

# Print the port of a production tunnel already open in the range prod_pick_port
# searches from $1, if any. Needs lsof to tell tunnels apart.
prod_find_tunnel() {
  command -v lsof >/dev/null 2>&1 || return 1
  local port
  for port in $(seq "$1" $(($1 + 19))); do
    if [ -n "$(prod_port_pid "$port")" ] && prod_port_is_tunnel "$port"; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

# Print the first free port from $1 up (20 tries), saying on stderr who holds
# each one skipped. Another project's dev tunnel on the same port is the usual
# reason (e.g. AYE Tec's taxi tunnel on 15432).
prod_pick_port() {
  local port="$1" last=$(($1 + 19))
  while [ "$port" -le "$last" ]; do
    if ! prod_port_busy "$port"; then
      [ "$port" = "$1" ] || echo "[tunnel] using 127.0.0.1:$port instead of $1." >&2
      echo "$port"
      return 0
    fi
    echo "[tunnel] 127.0.0.1:$port is taken by $(prod_port_owner "$port")." >&2
    port=$((port + 1))
  done
  echo "ERROR: ports $1-$last are all taken; set AGENTS_PROD_TUNNEL_PORT elsewhere." >&2
  return 1
}

# Print the public key the 1Password agent holds for AGENTS_PROD_SSH_1P_KEY,
# matched by fingerprint (SHA256:...) or by comment, which 1Password sets to the
# item title. Prints nothing when the agent is absent or lacks the key. Listing
# keys needs no approval; only signing does.
prod_1password_pubkey() {
  [ -n "$AGENTS_PROD_SSH_1P_KEY" ] && [ -S "$AGENTS_PROD_SSH_1P_SOCK" ] || return 0
  local keys line fp comment one
  keys="$(SSH_AUTH_SOCK="$AGENTS_PROD_SSH_1P_SOCK" ssh-add -L 2>/dev/null)" || return 0
  one="$(mktemp "${TMPDIR:-/tmp}/agents-prod-key.XXXXXX")"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '%s\n' "$line" >"$one"
    fp="$(ssh-keygen -lf "$one" 2>/dev/null | awk '{print $2}')"
    comment="$(printf '%s' "$line" | cut -d' ' -f3-)"
    if [ "$fp" = "$AGENTS_PROD_SSH_1P_KEY" ] || [ "$comment" = "$AGENTS_PROD_SSH_1P_KEY" ]; then
      printf '%s\n' "$line"
      break
    fi
  done <<<"$keys"
  rm -f "$one"
}

# Build PROD_SSH, the ssh command line every remote call uses.
#
# 1. The 1Password SSH agent, when its socket answers and holds the key: ssh is
#    given the PUBLIC key only (IdentitiesOnly) and 1Password signs, asking for
#    approval the first time. The private key never touches the disk.
# 2. Otherwise the private key file AGENTS_PROD_SSH_KEY (.pem); ssh asks for its
#    passphrase, or uses the default agent if that agent already holds it.
# 3. With neither set, plain ssh: ~/.ssh/config decides (reko-3 is an alias there).
#
# Sets PROD_SSH_PUBKEY_FILE when (1) wrote a temporary public key; the caller
# removes it on exit.
prod_ssh_setup() {
  PROD_SSH=(ssh -o ConnectTimeout=10)
  # Approval prompts are fine from a terminal; without one, fail fast instead
  # of hanging on a passphrase nobody can type.
  if [ ! -t 0 ]; then
    PROD_SSH+=(-o BatchMode=yes)
  fi

  local pubkey
  pubkey="$(prod_1password_pubkey)"
  if [ -n "$pubkey" ]; then
    PROD_SSH_PUBKEY_FILE="$(mktemp "${TMPDIR:-/tmp}/agents-prod-1p.XXXXXX")"
    printf '%s\n' "$pubkey" >"$PROD_SSH_PUBKEY_FILE"
    PROD_SSH+=(-o "IdentityAgent=\"$AGENTS_PROD_SSH_1P_SOCK\"" -i "$PROD_SSH_PUBKEY_FILE" -o IdentitiesOnly=yes)
    echo "[ssh] key from the 1Password agent: $(printf '%s' "$pubkey" | cut -d' ' -f3-)" >&2
    return 0
  fi

  if [ -n "$AGENTS_PROD_SSH_1P_KEY" ]; then
    if [ -S "$AGENTS_PROD_SSH_1P_SOCK" ]; then
      echo "[ssh] 1Password agent does not hold '$AGENTS_PROD_SSH_1P_KEY'; falling back to the key file." >&2
    else
      echo "[ssh] 1Password agent not running ($AGENTS_PROD_SSH_1P_SOCK); falling back to the key file." >&2
    fi
  fi

  if [ -n "$AGENTS_PROD_SSH_KEY" ] && [ -f "$AGENTS_PROD_SSH_KEY" ]; then
    PROD_SSH+=(-i "$AGENTS_PROD_SSH_KEY" -o IdentitiesOnly=yes)
    echo "[ssh] key from file: $AGENTS_PROD_SSH_KEY" >&2
    return 0
  fi

  if [ -n "$AGENTS_PROD_SSH_1P_KEY$AGENTS_PROD_SSH_KEY" ]; then
    echo "ERROR: no usable SSH key. Check AGENTS_PROD_SSH_1P_KEY (1Password) or AGENTS_PROD_SSH_KEY (a key file)." >&2
    exit 2
  fi
  echo "[ssh] no key configured; ~/.ssh/config decides for $AGENTS_PROD_SSH_HOST" >&2
}
