#!/usr/bin/env bash
# Standalone quality job for the isolated reko-3 rehearsal (GitHub uses checks.yml).
set -euo pipefail
cd "$(dirname "$0")/../.."
ctx="${DOCKER_CONTEXT:?explicit Docker context required}"
id="agents-quality-$(date +%s)"
cleanup() {
  code=$?; trap - EXIT
  docker --context "$ctx" rm -f "$id-runner" "$id-postgres" >/dev/null 2>&1 || true
  docker --context "$ctx" network rm "$id" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT
docker --context "$ctx" network create "$id" >/dev/null
docker --context "$ctx" run -d --name "$id-postgres" --network "$id" --network-alias postgres \
  -e POSTGRES_USER=agents -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=agents_test \
  --tmpfs /var/lib/postgresql postgres:18.6-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker --context "$ctx" exec "$id-postgres" pg_isready -U agents -d agents_test >/dev/null; then break; fi
  sleep 1
done
docker --context "$ctx" run --name "$id-runner" --network "$id" -v "$PWD:/app" -w /app \
  -e AGENTS_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e AGENTS_TEST_DATABASE_URL=postgres://agents:ci-only-password@postgres:5432/agents_test \
  -e LEFTHOOK=0 oven/bun:1.4.2 sh -ec 'bun install --frozen-lockfile; cd server; bunx tsc --noEmit; bun test; cd ../web; bunx tsc --noEmit; bun test; bun run build'
