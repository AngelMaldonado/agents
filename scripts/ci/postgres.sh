#!/usr/bin/env bash
# PostgreSQL for the Quality job, and gone afterwards.
#   start: a throwaway postgres:18.6-alpine, reachable from the job; stop: removes it (run it with if: always()).
# Where it is reachable depends on the Docker the job talks to:
#   - a self-hosted runner that is a container with the host's Docker socket: it joins the runner container's
#     network, so it is at the job's 127.0.0.1:5432;
#   - a Docker in Docker (DOCKER_HOST=tcp://<host>:<port>, Runner Fleet's default on reko-3, shared by the
#     runners of several repositories): it is published on that daemon on a free port, at <host>:<port>;
#   - a plain host (a runner process, GitHub-hosted): published on a free port of 127.0.0.1.
# Off the runner's own network the job's database URLs are pointed at it (GITHUB_ENV).
# It is ready only once the job itself reaches it.
set -euo pipefail
name="agents-ci-pg-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${GITHUB_JOB:-quality}"
user=agents password=ci-only-password db=agents_test
case "${1:-}" in
  start)
    host=127.0.0.1 port=5432
    self="$(grep -oE '/containers/[0-9a-f]{64}' /proc/self/mountinfo 2>/dev/null | head -1 | cut -d/ -f3 || true)"
    if [ -n "$self" ] && docker inspect "$self" >/dev/null 2>&1; then
      mode='la red del contenedor del runner'
      network=(--network "container:$self")
    elif [[ "${DOCKER_HOST:-}" =~ ^tcp://([^:/]+) ]]; then
      host="${BASH_REMATCH[1]}"
      mode="Docker in Docker ($host)"
      network=(-p 5432)
    else
      mode='el host'
      network=(-p 127.0.0.1::5432)
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" "${network[@]}" --label agents.ci=quality \
      -e POSTGRES_USER="$user" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB="$db" \
      postgres:18.6-alpine >/dev/null
    if [ "${network[0]}" = -p ]; then port="$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')"; fi
    url="postgres://$user:$password@$host:$port/$db"
    if [ "$host:$port" != 127.0.0.1:5432 ] && [ -n "${GITHUB_ENV:-}" ]; then
      { echo "AGENTS_DATABASE_URL=$url"; echo "AGENTS_TEST_DATABASE_URL=$url"; } >>"$GITHUB_ENV"
    fi
    for _ in $(seq 1 60); do
      # Ready inside, and reachable from here (the job), not only from its own container.
      if docker exec "$name" pg_isready -h 127.0.0.1 -U "$user" -d "$db" >/dev/null 2>&1 &&
        (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
        echo "PostgreSQL listo en $host:$port, por $mode ($name)"
        exit 0
      fi
      sleep 1
    done
    docker logs "$name" || true
    echo "PostgreSQL no quedó alcanzable en $host:$port (por $mode) en 60 s" >&2
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
