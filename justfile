# Buyer: workers with a live browser. Everything runs on reko-3; this MacBook edits and syncs.
# Every docker call goes through --context reko-3; bind mounts are reko-3 paths.

ctx := "reko-3"
remote := "/home/woz/dev/work/buyer"
dc := "docker --context " + ctx + " compose -f compose.dev.yaml"
session := "cuby-buyer"

default:
    @just --list

# ---- dev environment on reko-3 ----

# dev: init | sync | watch | up | down | restart | logs [svc] | ps | open | session | stop | fake on|off
dev verb="up" arg="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{verb}}" in
      init)
        # Secrets are made on reko-3 and never leave it. Dev PIN: 1234.
        ssh {{ctx}} 'mkdir -p {{remote}} && cd {{remote}} && if [ ! -f .env.dev ]; then umask 077; printf "BUYER_ADMIN_PIN=1234\nBUYER_MASTER_KEY=%s\nBUYER_PROXY_KEY=%s\n" "$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > .env.dev; echo "created .env.dev"; else echo ".env.dev exists"; fi'
        ;;
      sync)
        rsync -az --delete --exclude node_modules --exclude .git --exclude 'data/' --exclude '.env*' --exclude dist --exclude .codegraph ./ {{ctx}}:{{remote}}/
        ;;
      watch)
        # Polls every second; rsync only sends what changed.
        while true; do just dev sync >/dev/null 2>&1 || echo "sync failed $(date +%T)"; sleep 1; done
        ;;
      up)
        just dev init
        just dev sync
        docker --context {{ctx}} image inspect buyer-sandbox:dev >/dev/null 2>&1 || just sandbox build
        {{dc}} --project-directory {{remote}} up -d
        echo "https://agents-dev.cubytest.space  (admin PIN: 1234)"
        ;;
      down)    {{dc}} --project-directory {{remote}} down ;;
      restart) just dev sync && {{dc}} --project-directory {{remote}} restart {{arg}} ;;
      logs)    {{dc}} --project-directory {{remote}} logs -f --tail 100 {{arg}} ;;
      ps)      {{dc}} --project-directory {{remote}} ps; docker --context {{ctx}} ps --filter label=buyer.instance=dev ;;
      open)    open https://agents-dev.cubytest.space ;;
      fake)
        # Swap CLIProxyAPI for the scripted fake LLM (scripts/fake-llm.ts): real sandbox, no tokens.
        just dev sync
        if [ "{{arg}}" = "on" ]; then
          BUYER_CLIPROXY_URL=http://fake-llm:8317 {{dc}} --project-directory {{remote}} --profile fake up -d fake-llm server
        else
          {{dc}} --project-directory {{remote}} up -d server
          {{dc}} --project-directory {{remote}} --profile fake rm -sf fake-llm
        fi
        ;;
      session)
        # tmux session with the sync loop and the logs; attach with: tmux attach -t {{session}}
        if tmux has-session -t {{session}} 2>/dev/null; then echo "{{session}} already running"; exit 0; fi
        just dev up
        tmux new-session -d -s {{session}} -n sync -c "$PWD" 'just dev watch'
        tmux new-window -t {{session}} -n logs -c "$PWD" 'just dev logs'
        tmux set-option -t {{session}} @owner agent
        tmux set-option -t {{session}} @purpose 'buyer dev env on reko-3: rsync loop + compose logs'
        echo "tmux attach -t {{session}}"
        ;;
      stop)
        tmux kill-session -t {{session}} 2>/dev/null || true
        just dev down
        ;;
      *) echo "unknown: just dev {{verb}}"; exit 1 ;;
    esac

# ---- the sandbox image ----

# sandbox: build | shell
sandbox verb="build":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{verb}}" in
      build) docker --context {{ctx}} build -t buyer-sandbox:dev sandbox/ ;;
      shell) docker --context {{ctx}} run --rm -it --cap-drop ALL --security-opt no-new-privileges --shm-size 512m --entrypoint bash buyer-sandbox:dev ;;
      *) echo "unknown: just sandbox {{verb}}"; exit 1 ;;
    esac

# ---- checks ----

check:
    cd server && bunx tsc --noEmit
    cd web && bunx tsc --noEmit

# ---- production (Komodo stack `buyer` on reko-3) ----

# deploy: image | sandbox — then redeploy the stack in Komodo with IMAGE_TAG=<commit>
deploy verb="image":
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --quiet HEAD || { echo "commit first: the image must match a commit" >&2; exit 1; }
    tag=$(git rev-parse --short HEAD)
    case "{{verb}}" in
      image)
        docker buildx build --platform linux/amd64 -t registry.cubytest.space/cuby/buyer:$tag -t registry.cubytest.space/cuby/buyer:latest --push .
        echo "pushed registry.cubytest.space/cuby/buyer:$tag"
        ;;
      sandbox)
        docker --context {{ctx}} build -t buyer-sandbox:$tag -t buyer-sandbox:latest sandbox/
        echo "built buyer-sandbox:$tag on {{ctx}}"
        ;;
      *) echo "unknown: just deploy {{verb}}"; exit 1 ;;
    esac
