#!/usr/bin/env bash
# PostgreSQL for the Quality job, at 127.0.0.1:5432 of the job, and gone afterwards.
#   start: a throwaway postgres:18.6-alpine; stop: removes it (run it with if: always()).
# On a self-hosted runner that is itself a container (Runner Fleet on reko-3, with the host's Docker
# socket), the database joins the runner container's network: its 127.0.0.1 is the job's. On a plain
# host (a runner process, GitHub-hosted), it publishes the port on 127.0.0.1 instead.
set -euo pipefail
name="agents-ci-pg-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-quality}"
case "${1:-}" in
  start)
    self="$(grep -oE '/docker/containers/[0-9a-f]{64}' /proc/self/mountinfo 2>/dev/null | head -1 | cut -d/ -f4 || true)"
    if [ -n "$self" ] && docker inspect "$self" >/dev/null 2>&1; then
      network=(--network "container:$self")
    else
      network=(-p 127.0.0.1:5432:5432)
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" "${network[@]}" --label agents.ci=quality \
      -e POSTGRES_USER=agents -e POSTGRES_PASSWORD=ci-only-password -e POSTGRES_DB=agents_test \
      postgres:18.6-alpine >/dev/null
    for _ in $(seq 1 60); do
      if docker exec "$name" pg_isready -h 127.0.0.1 -U agents -d agents_test >/dev/null 2>&1; then
        echo "PostgreSQL listo en 127.0.0.1:5432 ($name)"
        exit 0
      fi
      sleep 1
    done
    docker logs "$name" || true
    echo 'PostgreSQL no arrancó en 60 s' >&2
    exit 1
    ;;
  stop)
    docker rm -f "$name" >/dev/null 2>&1 || true
    ;;
  *)
    echo 'Uso: scripts/ci/postgres.sh start|stop' >&2
    exit 2
    ;;
esac
