#!/usr/bin/env bash
set -euo pipefail
umask 077
trap 'rm -f .git/agents-release.env' EXIT
chmod 600 .git/agents-release.env
set -a
source .git/agents-release.env
set +a
# The read-only repo mount must never expose the signing envfile to build/verify.
rm -f .git/agents-release.env
case "${AGENTS_RELEASE_COMPONENT:?}" in agents-app|agents-sandbox) ;; *) exit 2 ;; esac
: "${AGENTS_RELEASE_TOOLS_IMAGE:?Imagen inmutable obligatoria}"
# One Repo job, three fresh containers. Private signing values enter ONLY the sign container.
for mode in build sign verify; do
  # Keep the array nonempty: Bash 3 + nounset mishandles an empty array expansion.
  phase_env=(-e DOCKER_CONTEXT=default)
  if [[ "$mode" == sign ]]; then phase_env+=(-e COSIGN_PRIVATE_KEY_B64 -e COSIGN_PASSWORD); fi
  docker --context default run --rm --name "${AGENTS_RELEASE_COMPONENT}-${mode}-job" \
    --cpus 1 --memory 1g --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,source=$PWD,target=/repo,readonly" \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    -e REGISTRY_USERNAME -e REGISTRY_PASSWORD "${phase_env[@]}" \
    -e AGENTS_RELEASE_SHA -e AGENTS_RELEASE_VERSION -e AGENTS_RELEASE_COMPONENT -e AGENTS_RELEASE_REHEARSAL \
    "$AGENTS_RELEASE_TOOLS_IMAGE" "$mode"
done
