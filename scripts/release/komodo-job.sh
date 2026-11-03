#!/usr/bin/env bash
set -euo pipefail
umask 077
docker_config=''
cleanup() {
  rm -f .git/agents-release.env
  if [[ -n "$docker_config" ]]; then rm -rf -- "$docker_config"; fi
}
trap cleanup EXIT
chmod 600 .git/agents-release.env
set -a
source .git/agents-release.env
set +a
# The read-only repo mount must never expose the signing envfile to build/verify.
rm -f .git/agents-release.env
case "${AGENTS_RELEASE_COMPONENT:?}" in agents-app|agents-sandbox) ;; *) exit 2 ;; esac
: "${AGENTS_RELEASE_TOOLS_IMAGE:?Imagen inmutable obligatoria}"
if ! [[ "$AGENTS_RELEASE_TOOLS_IMAGE" =~ ^registry\.cubytest\.space/cuby/agents-release-tools@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Tools image requiere referencia del registry aprobado por digest, no ID local ni tag.' >&2
  exit 2
fi
# A local image ID is not recoverable after cache cleanup. Fetch the pinned manifest every job.
# Registry auth lives outside the mounted repo and is removed before any phase starts.
docker_config=$(mktemp -d /tmp/agents-release-docker.XXXXXX)
printf '%s' "${REGISTRY_PASSWORD:?}" | docker --config "$docker_config" --context default login \
  registry.cubytest.space --username "${REGISTRY_USERNAME:?}" --password-stdin
docker --config "$docker_config" --context default pull --platform linux/amd64 "$AGENTS_RELEASE_TOOLS_IMAGE"
rm -rf -- "$docker_config"
docker_config=''
# One Repo job: build, sign and verify in three fresh containers; or, later, only promote (move :beta to
# the verified digest). Private signing values enter ONLY the sign container.
case "${AGENTS_RELEASE_PHASES:-build sign verify}" in
  'build sign verify') phases=(build sign verify) ;;
  promote) phases=(promote) ;;
  *) echo 'Fases inválidas.' >&2; exit 2 ;;
esac
for mode in "${phases[@]}"; do
  # Keep the array nonempty: Bash 3 + nounset mishandles an empty array expansion.
  phase_env=(-e DOCKER_CONTEXT=default)
  if [[ "$mode" == sign ]]; then phase_env+=(-e COSIGN_PRIVATE_KEY_B64 -e COSIGN_PASSWORD); fi
  docker --context default run --pull=never --rm --name "${AGENTS_RELEASE_COMPONENT}-${mode}-job" \
    --cpus 1 --memory 1g --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    --mount "type=bind,source=$PWD,target=/repo,readonly" \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    -e REGISTRY_USERNAME -e REGISTRY_PASSWORD "${phase_env[@]}" \
    -e AGENTS_RELEASE_SHA -e AGENTS_RELEASE_VERSION -e AGENTS_RELEASE_COMPONENT -e AGENTS_RELEASE_REHEARSAL \
    -e AGENTS_RELEASE_DIGEST \
    "$AGENTS_RELEASE_TOOLS_IMAGE" "$mode"
done
