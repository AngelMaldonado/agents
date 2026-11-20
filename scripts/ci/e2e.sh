#!/usr/bin/env bash
# Dedicated project/network/volumes. Never uses dev/prod compose, DB, routing or credentials.
#
# GitHub's Sandbox E2E runs it as is. `just release` (scripts/release/release.ts) runs it against reko-5 with:
#   AGENTS_CI_ID            the name of everything it creates (default: from the GitHub run)
#   AGENTS_CI_APP_IMAGE     test these images instead of building them (and leave them: they are the release's)
#   AGENTS_CI_SANDBOX_IMAGE
#   AGENTS_CI_SHA           the code that goes into the test runner: that commit (git archive), not this checkout
#   AGENTS_CI_BRIDGE        a fixed bridge name for the test network: one the host's egress lock covers
#   AGENTS_CI_DB_TESTS=1    also the server's tests against the job's PostgreSQL (GitHub runs them in Quality)
set -euo pipefail
cd "$(dirname "$0")/../.."
ctx="${DOCKER_CONTEXT:-default}"
# The sandbox's Dockerfile needs BuildKit (COPY --chmod): buildx, which the workflow installs where it is missing.
export DOCKER_BUILDKIT=1
id="${AGENTS_CI_ID:-agents-ci-${GITHUB_RUN_ID:-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}}"
network="$id"
postgres="$id-postgres"
api="$id-api"
sandbox_image="${AGENTS_CI_SANDBOX_IMAGE:-$id-sandbox}"
app_image="${AGENTS_CI_APP_IMAGE:-$id-app}"
built=()
cleanup() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then docker --context "$ctx" logs "$api" 2>/dev/null || true; fi
  docker --context "$ctx" ps -aq --filter "network=$network" | while read -r container; do
    [ -z "$container" ] || docker --context "$ctx" rm -f "$container" >/dev/null 2>&1 || true
  done
  docker --context "$ctx" volume ls -q --filter "name=agents-$id-" | while read -r volume; do
    case "$volume" in agents-"$id"-*) docker --context "$ctx" volume rm "$volume" >/dev/null 2>&1 || true;; esac
  done
  # Test image keepers (agents.keep=dev, never production's =prod) of the tested sandbox: they would pin it on the host.
  docker --context "$ctx" ps -aq --filter label=agents.keep=dev --filter "ancestor=$sandbox_image" | while read -r container; do
    [ -z "$container" ] || docker --context "$ctx" rm -f "$container" >/dev/null 2>&1 || true
  done
  docker --context "$ctx" network rm "$network" >/dev/null 2>&1 || true
  if [ "${#built[@]}" -gt 0 ]; then docker --context "$ctx" image rm "${built[@]}" >/dev/null 2>&1 || true; fi
  exit "$code"
}
trap cleanup EXIT
if [ -z "${AGENTS_CI_SANDBOX_IMAGE:-}" ]; then
  docker --context "$ctx" build --platform linux/amd64 -t "$sandbox_image" sandbox/
  built+=("$sandbox_image")
fi
if [ -z "${AGENTS_CI_APP_IMAGE:-}" ]; then
  docker --context "$ctx" build --platform linux/amd64 -t "$app_image" .
  built+=("$app_image")
fi
bridge=() dns=()
if [ -n "${AGENTS_CI_BRIDGE:-}" ]; then
  bridge=(--opt "com.docker.network.bridge.name=$AGENTS_CI_BRIDGE")
  # The lock also keeps the host's LAN resolver out: public ones, as the sandboxes use (AGENTS_SANDBOX_DNS).
  dns=(--dns 1.1.1.1 --dns 9.9.9.9)
fi
docker --context "$ctx" network create ${bridge[@]+"${bridge[@]}"} "$network" >/dev/null
docker --context "$ctx" run -d --name "$postgres" --network "$network" --network-alias postgres \
  -e POSTGRES_USER=agents -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=agents_test \
  --tmpfs /var/lib/postgresql postgres:18.6-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker --context "$ctx" exec "$postgres" pg_isready -U agents -d agents_test >/dev/null; then break; fi
  sleep 1
done
# Boot the ACTUAL production candidate too: build success is not proof that prod dependencies resolve.
ready="$id-ready"
docker --context "$ctx" run -d --name "$ready" --network "$network" ${dns[@]+"${dns[@]}"} \
  -e AGENTS_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e AGENTS_MASTER_KEY=MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA= \
  -e AGENTS_PROXY_KEY=ci-fixture-only -e AGENTS_ADMIN_PIN=1111 -e AGENTS_COOKIE_SECURE=0 -e AGENTS_KEEP_IMAGES=0 \
  "$app_image" >/dev/null
healthy=0
for _ in $(seq 1 60); do
  if docker --context "$ctx" exec "$ready" bun -e 'const r=await fetch("http://127.0.0.1:8787/healthz"); if(!r.ok || !(await r.json()).ready) process.exit(1)' >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ "$healthy" != 1 ]; then docker --context "$ctx" logs "$ready"; exit 1; fi
docker --context "$ctx" rm -f "$ready" >/dev/null
echo 'PASS actual app image boots with production-only dependencies and /healthz is ready'
# The test runner is trusted merged/PR code on a disposable CI machine, NEVER the production host.
docker --context "$ctx" create --name "$api" --network "$network" --network-alias agents-ci-api ${dns[@]+"${dns[@]}"} \
  -v /var/run/docker.sock:/var/run/docker.sock -w /app \
  -e LEFTHOOK=0 \
  -e AGENTS_TEST_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e AGENTS_TEST_INSTANCE_PREFIX="$id" -e AGENTS_SANDBOX_NETWORK="$network" -e AGENTS_SANDBOX_SERVER_URL=http://agents-ci-api:8787 \
  -e AGENTS_SANDBOX_IMAGE="$sandbox_image" -e AGENTS_CI_DB_TESTS="${AGENTS_CI_DB_TESTS:-0}" \
  -e AGENTS_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e AGENTS_MASTER_KEY=MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA= -e AGENTS_PROXY_KEY=ci-fixture-only \
  -e AGENTS_WEB_DIST=/nonexistent -e AGENTS_KEEP_IMAGES=0 oven/bun:1.4.2 \
  sh -ec 'bun install --frozen-lockfile
    if [ "$AGENTS_CI_DB_TESTS" = 1 ]; then (cd server && bun test); echo "PASS server tests against the job database"; fi
    bun scripts/design-smoke.ts; bun scripts/sharing-smoke.ts' >/dev/null
# The repository goes in by copy, not mounted: the daemon may not see this machine's paths (a Docker in Docker
# self-hosted runner). Its dependencies are installed inside.
if [ -n "${AGENTS_CI_SHA:-}" ]; then
  git archive --format=tar --prefix=app/ "$AGENTS_CI_SHA" | docker --context "$ctx" cp - "$api":/
else
  tar -C . --exclude=./node_modules --exclude=./server/node_modules --exclude=./web/node_modules \
    --transform 's,^\.,app,' -cf - . | docker --context "$ctx" cp - "$api":/
fi
docker --context "$ctx" start "$api" >/dev/null
result="$(docker --context "$ctx" wait "$api")"
docker --context "$ctx" logs "$api"
test "$result" = 0
