#!/usr/bin/env bash
set -euo pipefail
expected="${1:?SHA completo obligatorio}"
actual="$(git rev-parse HEAD)"
[[ "$actual" == "$expected" ]]
[[ -z "$(git status --porcelain --untracked-files=all)" ]]
printf 'AGENTS_RELEASE_SOURCE_SHA %s\n' "$actual"
