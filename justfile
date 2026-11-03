# Agents: workers with a live browser. In dev the backend and the web run on this Mac and the
# sandboxes on reko-2 (docker --context reko-2, see scripts/dev/env.sh); prod lives on reko-3.

session := "cuby-agents"
prod_dir := justfile_directory() / "scripts/prod"
prod_session := "cuby-agents-prod"

default:
    @just --list

# ---- dev environment: backend + web on this Mac, sandboxes on reko-2 ----

# dev defaults to session: everything in tmux `cuby-agents`, one window per process (scripts/dev/run.sh).
# dev: init | session | up | stop | down | restart [win] | logs [win] | ps | open | fake on|off | test | design | sharing | psql
dev verb="session" arg="":
    #!/usr/bin/env bash
    set -euo pipefail
    . scripts/dev/env.sh
    s="{{session}}"
    wins="tunnel db cliproxy fake proxy server web whatsapp"
    attach() { if [ -t 0 ] && [ -t 1 ] && [ -z "${TMUX:-}" ]; then exec tmux attach -t "$s"; fi; echo "tmux attach -t $s"; }
    case "{{verb}}" in
      init) scripts/dev/init.sh ;;
      session|up)
        if tmux has-session -t "$s" 2>/dev/null; then echo "$s already running"; attach; exit 0; fi
        scripts/dev/init.sh
        docker --context "$SBX_CTX" image inspect "$SBX_IMAGE" >/dev/null 2>&1 || just sandbox build
        docker --context "$SBX_CTX" image inspect "$PROXY_IMAGE" >/dev/null 2>&1 || just proxy build
        first=1
        for w in $wins; do
          if [ $first = 1 ]; then tmux new-session -d -s "$s" -n "$w" -c "$ROOT" "scripts/dev/run.sh $w"; first=0
          else tmux new-window -d -t "$s" -n "$w" -c "$ROOT" "scripts/dev/run.sh $w"; fi
          tmux set-option -w -t "$s:$w" remain-on-exit on
        done
        tmux set-option -t "$s" @owner agent
        tmux set-option -t "$s" @purpose 'agents dev: server + web on this Mac, sandboxes on reko-2'
        echo "$WEB_URL  (admin PIN: 1234)"
        attach
        ;;
      stop|down)
        tmux kill-session -t "$s" 2>/dev/null && echo "closed $s" || echo "$s was not running"
        # Postgres survives the SIGHUP of kill-session; stop it explicitly.
        if pg_ctl -D "$PG_DATA" status >/dev/null 2>&1; then pg_ctl -D "$PG_DATA" -m fast -w stop >/dev/null && echo "stopped Postgres"; fi
        ;;
      restart)
        a="{{arg}}"
        for w in ${a:-server web}; do
          tmux respawn-window -k -t "$s:$w"
        done
        ;;
      logs) if [ -n "{{arg}}" ]; then tail -n 100 -f "$DEV/logs/{{arg}}.log"; else tail -n 20 -f "$DEV"/logs/*.log; fi ;;
      ps)
        tmux list-windows -t "$s" -F '#{window_name}  #{?pane_dead,DEAD (exit #{pane_dead_status}),running}' 2>/dev/null || echo "$s is not running"
        docker --context "$SBX_CTX" ps --filter label=agents.instance=dev
        ;;
      open) open "$WEB_URL" ;;
      fake)
        # Swap CLIProxyAPI for the scripted fake LLM (scripts/fake-llm.ts): real sandbox, no tokens.
        case "{{arg}}" in on) echo fake > "$LLM_MODE_FILE" ;; off) echo real > "$LLM_MODE_FILE" ;; *) echo "just dev fake on|off"; exit 2 ;; esac
        tmux has-session -t "$s" 2>/dev/null && just dev restart server || true
        echo "LLM: $(cat "$LLM_MODE_FILE")"
        ;;
      test)
        # The server's tests against the dev Postgres' agents_test database.
        server_env
        cd server && AGENTS_DATABASE_URL="$TEST_DB_URL" bun test
        ;;
      design)
        # Isolated DB/API and fake GPT; actual dev sandbox initialization on reko-2. Cleans up its own labels.
        server_env
        bun run scripts/design-smoke.ts
        ;;
      sharing)
        # Isolated DB/API, fake GPT and real sandboxes on reko-2: shared users wait for one another.
        server_env
        bun run scripts/sharing-smoke.ts
        ;;
      psql)
        # The dev database (throwaway; read-write).
        exec psql -h 127.0.0.1 -p "$PG_PORT" -U agents agents
        ;;
      *) echo "unknown: just dev {{verb}}"; exit 1 ;;
    esac

# ---- the sandbox image (dev: arm64 on reko-2) ----

# sandbox: build | shell
sandbox verb="build":
    #!/usr/bin/env bash
    set -euo pipefail
    . scripts/dev/env.sh
    case "{{verb}}" in
      build) docker --context "$SBX_CTX" build -t "$SBX_IMAGE" sandbox/ ;;
      shell) docker --context "$SBX_CTX" run --rm -it --cap-drop ALL --security-opt no-new-privileges --shm-size 512m --entrypoint bash "$SBX_IMAGE" ;;
      *) echo "unknown: just sandbox {{verb}}"; exit 1 ;;
    esac

# ---- the egress proxy of API keys (#24; dev: arm64 on reko-2) ----

# proxy: build | logs
proxy verb="build":
    #!/usr/bin/env bash
    set -euo pipefail
    . scripts/dev/env.sh
    case "{{verb}}" in
      build) docker --context "$SBX_CTX" build -t "$PROXY_IMAGE" proxy/ ;;
      logs) tail -n 100 -f "$DEV/logs/proxy.log" ;;
      *) echo "unknown: just proxy {{verb}}"; exit 1 ;;
    esac

# ---- checks ----

# Types here; the database tests skip without Postgres: `just dev test` runs them against the dev Postgres.
check:
    cd server && bunx tsc --noEmit
    cd web && bunx tsc --noEmit
    cd server && bun test
    cd web && bun test
    bun test scripts/release
    bun test scripts/deploy
    python3 -B scripts/backup/s3_test.py
    python3 -B proxy/swap_test.py
    python3 -B scripts/deploy/cutover_test.py
    python3 -B scripts/deploy/transfer_test.py

# ---- quality and release (never sync the checkout serving users) ----

sanitize mode="history":
    bun scripts/tooling/sanitize.mjs {{mode}}

format mode="check":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{mode}}" in
      check) bun run format:check ;;
      write) bun run format ;;
      *) echo 'format: check | write' >&2; exit 2 ;;
    esac

lint:
    bun run lint

# Fast checks above may skip DB tests locally. CI MUST supply a throwaway _test DB.
ci:
    bun scripts/ci/verify-database.ts
    just sanitize history
    just format check
    just lint
    just check
    cd web && bun run build

# `just release` publishes the next beta and points the `:beta` tags at it (after signing and verifying);
# production then only needs Pull + Deploy in Komodo. `just release promote <version>` points `:beta` at a
# published version again (a rollback). Neither deploys.
release mode="run" arg="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{mode}}" in
      promote) bun scripts/release/promote.mjs {{arg}} ;;
      *) bun scripts/release/main.mjs {{mode}} ;;
    esac

# ---- production (Komodo stack `agents` on reko-3) ----

# Preparation ONLY. No apply/cutover exists; publication stays in `just release`.
deploy verb="plan":
    python3 scripts/deploy/prepare.py {{verb}}

# Operación beta1 explícitamente autorizada; no reutilizar como deploy genérico.
transfer action="audit" run="":
    python3 -B scripts/deploy/transfer.py {{quote(action)}} {{if run != "" { quote(run) } else { "" }}}

# Catálogo y ensayo LOCAL de control; no usa SSH ni implementa apply.
cutover action="plan":
    python3 -B scripts/deploy/cutover.py {{quote(action)}}

# S3 opt-in para respaldos ya creados; no despliega ni crea snapshots coordinados.
backup action="plan" target="":
    python3 scripts/backup/s3.py {{quote(action)}} {{quote(target)}}

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
