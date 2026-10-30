#!/usr/bin/env bash
set -euo pipefail
umask 077
mode="${1:?sign, verify o probe}"
case "$mode" in sign|verify|probe) ;; *) exit 2 ;; esac
# Komodo renders this git-internal file ONLY on its executor. Never copy it out.
chmod 600 .git/agents-release.env
set -a
source .git/agents-release.env
set +a
trap 'rm -f .git/agents-release.env' EXIT
private=()
if [[ "$mode" != verify ]]; then
  private=(-e COSIGN_PRIVATE_KEY_B64 -e COSIGN_PASSWORD)
fi
: "${AGENTS_RELEASE_TOOLS_IMAGE:?Imagen inmutable del executor obligatoria}"
docker --context default run --rm --name "agents-release-${mode}-job" \
  --cpus 1 --memory 1g --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --mount "type=bind,source=$PWD,target=/repo,readonly" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  -e REGISTRY_USERNAME -e REGISTRY_PASSWORD "${private[@]}" \
  -e AGENTS_RELEASE_SHA -e AGENTS_RELEASE_VERSION -e AGENTS_RELEASE_APP_TAG -e AGENTS_RELEASE_SANDBOX_TAG \
  -e DOCKER_CONTEXT=default -e COSIGN_PUBLIC_KEY_FILE=/repo/release/cosign.pub \
  -e COSIGN_KEY_REF=env://COSIGN_PRIVATE_KEY \
  "$AGENTS_RELEASE_TOOLS_IMAGE" "$mode"
