#!/usr/bin/env bash
# Dedicated project/network/volumes. Never uses dev/prod compose, DB, routing or credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."
ctx="${DOCKER_CONTEXT:-default}"
id="agents-ci-${GITHUB_RUN_ID:-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}"
network="$id"
postgres="$id-postgres"
api="$id-api"
sandbox_image="$id-sandbox"
app_image="$id-app"
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
  docker --context "$ctx" network rm "$network" >/dev/null 2>&1 || true
  docker --context "$ctx" image rm "$app_image" "$sandbox_image" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT
docker --context "$ctx" build --platform linux/amd64 -t "$sandbox_image" sandbox/
docker --context "$ctx" build --platform linux/amd64 -t "$app_image" .
docker --context "$ctx" network create "$network" >/dev/null
docker --context "$ctx" run -d --name "$postgres" --network "$network" --network-alias postgres \
  -e POSTGRES_USER=agents -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=agents_test \
  --tmpfs /var/lib/postgresql postgres:18.6-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker --context "$ctx" exec "$postgres" pg_isready -U agents -d agents_test >/dev/null; then break; fi
  sleep 1
done
# Boot the ACTUAL production candidate too: build success is not proof that prod dependencies resolve.
ready="$id-ready"
docker --context "$ctx" run -d --name "$ready" --network "$network" \
  -e AGENTS_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e AGENTS_MASTER_KEY=MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA= \
  -e AGENTS_PROXY_KEY=ci-fixture-only -e AGENTS_ADMIN_PIN=1111 -e AGENTS_COOKIE_SECURE=0 \
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
docker --context "$ctx" run -d --name "$api" --network "$network" --network-alias agents-ci-api \
  -v "$PWD:/app" -v /var/run/docker.sock:/var/run/docker.sock -w /app \
  -e LEFTHOOK=0 \
  -e AGENTS_TEST_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e AGENTS_TEST_INSTANCE_PREFIX="$id" -e AGENTS_SANDBOX_NETWORK="$network" -e AGENTS_SANDBOX_SERVER_URL=http://agents-ci-api:8787 \
  -e AGENTS_SANDBOX_IMAGE="$sandbox_image" oven/bun:1.4.2 \
  sh -ec 'bun install --frozen-lockfile; bun scripts/design-smoke.ts; bun scripts/sharing-smoke.ts' >/dev/null
result="$(docker --context "$ctx" wait "$api")"
docker --context "$ctx" logs "$api"
test "$result" = 0
