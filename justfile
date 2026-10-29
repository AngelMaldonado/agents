# Agents: workers with a live browser. Everything runs on reko-3; this MacBook edits and syncs.
# Every docker call goes through --context reko-3; bind mounts are reko-3 paths.

ctx := "reko-3"
remote := "/home/woz/dev/work/agents"
dc := "docker --context " + ctx + " compose -f compose.dev.yaml"
session := "cuby-agents"
prod_dir := justfile_directory() / "scripts/prod"
prod_session := "cuby-agents-prod"

default:
    @just --list

# ---- dev environment on reko-3 ----

# dev defaults to session: start the stack, continuous sync and logs in tmux.
# dev: init | sync | watch | up | down | restart | logs [svc] | ps | open | session | stop | fake on|off | test | design | psql
dev verb="session" arg="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{verb}}" in
      init)
        # Secrets are made on reko-3 and never leave it. Dev PIN: 1234.
        ssh {{ctx}} 'mkdir -p {{remote}} && cd {{remote}} && if [ ! -f .env.dev ]; then umask 077; printf "AGENTS_ADMIN_PIN=1234\nAGENTS_MASTER_KEY=%s\nAGENTS_PROXY_KEY=%s\n" "$(openssl rand -base64 32)" "$(openssl rand -hex 24)" > .env.dev; echo "created .env.dev"; else echo ".env.dev exists"; fi; grep -q "^AGENTS_WHATSAPP_SECRET=" .env.dev || { printf "AGENTS_WHATSAPP_SECRET=%s\n" "$(openssl rand -hex 24)" >> .env.dev; echo "added AGENTS_WHATSAPP_SECRET"; }'
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
        docker --context {{ctx}} image inspect agents-sandbox:dev >/dev/null 2>&1 || just sandbox build
        docker --context {{ctx}} image inspect agents-whatsapp:dev >/dev/null 2>&1 || just whatsapp build
        {{dc}} --project-directory {{remote}} up -d
        echo "https://agents-dev.cubytest.space  (admin PIN: 1234)"
        ;;
      down)    {{dc}} --project-directory {{remote}} down ;;
      restart) just dev sync && {{dc}} --project-directory {{remote}} restart {{arg}} ;;
      logs)    {{dc}} --project-directory {{remote}} logs -f --tail 100 {{arg}} ;;
      ps)      {{dc}} --project-directory {{remote}} ps; docker --context {{ctx}} ps --filter label=agents.instance=dev ;;
      open)    open https://agents-dev.cubytest.space ;;
      fake)
        # Swap CLIProxyAPI for the scripted fake LLM (scripts/fake-llm.ts): real sandbox, no tokens.
        just dev sync
        if [ "{{arg}}" = "on" ]; then
          AGENTS_CLIPROXY_URL=http://fake-llm:8317 {{dc}} --project-directory {{remote}} --profile fake up -d fake-llm server
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
        tmux set-option -t {{session}} @purpose 'agents dev env on reko-3: rsync loop + compose logs'
        echo "tmux attach -t {{session}}"
        ;;
      stop)
        tmux kill-session -t {{session}} 2>/dev/null || true
        just dev down
        ;;
      test)
        # The server's tests against the dev Postgres' agents_test database, inside the server container.
        just dev sync
        {{dc}} --project-directory {{remote}} exec -T server sh -c 'cd server && AGENTS_DATABASE_URL="${AGENTS_TEST_DATABASE_URL:?missing test database}" bun test'
        ;;
      design)
        # Isolated DB/API and fake GPT; actual dev sandbox initialization. Cleans up its own labels.
        just dev sync
        {{dc}} --project-directory {{remote}} exec -T server bun run scripts/design-smoke.ts
        ;;
      psql)
        # The dev database (throwaway; read-write).
        {{dc}} --project-directory {{remote}} exec postgres psql -U agents -d agents
        ;;
      *) echo "unknown: just dev {{verb}}"; exit 1 ;;
    esac

# ---- the sandbox image ----

# sandbox: build | shell | egress (checks the egress firewall from the dev sandbox network)
sandbox verb="build":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{verb}}" in
      build) docker --context {{ctx}} build -t agents-sandbox:dev sandbox/ ;;
      shell) docker --context {{ctx}} run --rm -it --cap-drop ALL --security-opt no-new-privileges --shm-size 512m --entrypoint bash agents-sandbox:dev ;;
      egress) docker --context {{ctx}} run --rm -i --network agents-dev-sandbox --dns 1.1.1.1 -e SERVER=agents-dev-server --entrypoint bash agents-sandbox:dev -s < scripts/egress-check.sh ;;
      *) echo "unknown: just sandbox {{verb}}"; exit 1 ;;
    esac

# ---- the WhatsApp bridge image (whatsapp/, whatsmeow) ----

# whatsapp: build (the dev image; `just dev up` uses it) | logs
whatsapp verb="build":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{verb}}" in
      build) docker --context {{ctx}} build -t agents-whatsapp:dev whatsapp/ ;;
      logs) docker --context {{ctx}} logs -f --tail 100 agents-dev-whatsapp-1 ;;
      *) echo "unknown: just whatsapp {{verb}}"; exit 1 ;;
    esac

# ---- checks ----

# Types here; the database tests skip without Postgres: `just dev test` runs them on reko-3.
check:
    cd server && bunx tsc --noEmit
    cd web && bunx tsc --noEmit
    cd server && bun test
    cd web && bun test

# ---- production (Komodo stack `agents` on reko-3) ----

# deploy: image | sandbox | whatsapp — then redeploy the stack in Komodo with IMAGE_TAG=<commit>
deploy verb="image":
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --quiet HEAD || { echo "commit first: the image must match a commit" >&2; exit 1; }
    tag=$(git rev-parse --short HEAD)
    case "{{verb}}" in
      image)
        docker --context {{ctx}} buildx build --platform linux/amd64 -t registry.cubytest.space/cuby/agents:$tag -t registry.cubytest.space/cuby/agents:latest --push .
        echo "pushed registry.cubytest.space/cuby/agents:$tag"
        ;;
      sandbox)
        docker --context {{ctx}} build -t agents-sandbox:$tag -t agents-sandbox:latest sandbox/
        echo "built agents-sandbox:$tag on {{ctx}}"
        ;;
      whatsapp)
        docker --context {{ctx}} buildx build --platform linux/amd64 -t registry.cubytest.space/cuby/agents-whatsapp:$tag -t registry.cubytest.space/cuby/agents-whatsapp:latest --push whatsapp/
        echo "pushed registry.cubytest.space/cuby/agents-whatsapp:$tag"
        ;;
      *) echo "unknown: just deploy {{verb}}"; exit 1 ;;
    esac

# prod: psql | tunnel | stop — the production database, in tmux `cuby-agents-prod` (read-only by default)
prod action:
    #!/usr/bin/env bash
    set -euo pipefail
    session="{{prod_session}}"
    case "{{action}}" in
      psql)
        if ! tmux has-session -t "$session" 2>/dev/null; then
          # Picked here, in a subshell so the credentials stay out of tmux,
          # and shared with both windows through the session environment.
          port="$(source "{{prod_dir}}/lib.sh" && prod_pick_port "$AGENTS_PROD_TUNNEL_PORT")"
          tmux new-session -d -s "$session" -e "PROD_TUNNEL_PORT=$port" -n tunnel -c "{{justfile_directory()}}" "{{prod_dir}}/tunnel.sh"
          tmux set-option -t "$session" @purpose 'agents production database: tunnel + read-only psql'
        elif ! tmux list-windows -t "$session" -F '#W' | grep -qx tunnel; then
          # A visible deploy/inspection may already own this session without a DB tunnel.
          port="$(source "{{prod_dir}}/lib.sh" && prod_pick_port "$AGENTS_PROD_TUNNEL_PORT")"
          tmux set-environment -t "$session" PROD_TUNNEL_PORT "$port"
          tmux new-window -t "$session" -n tunnel -c "{{justfile_directory()}}" "{{prod_dir}}/tunnel.sh"
        fi
        if ! tmux list-windows -t "$session" -F '#W' | grep -qx psql; then
          tmux new-window -t "$session" -n psql -c "{{justfile_directory()}}" "{{prod_dir}}/psql.sh"
        fi
        tmux select-window -t "$session:psql"
        if [ -t 0 ] && [ -t 1 ] && [ -z "${TMUX:-}" ]; then
          exec tmux attach-session -t "$session"
        fi
        echo "Production psql is in tmux session '$session', window 'psql'."
        echo "Attach with: tmux attach -t $session"
        ;;
      tunnel) exec "{{prod_dir}}/tunnel.sh" ;;
      stop) tmux kill-session -t "$session" 2>/dev/null && echo "Closed '$session'." || echo "'$session' was not running." ;;
      *) echo "unknown: just prod {{action}} (psql | tunnel | stop)"; exit 2 ;;
    esac
