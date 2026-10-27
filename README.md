# Agents

Agentes IA con su propia computadora (shell + Chrome) y un navegador que se ve en vivo. Herramienta interna de Cuby en `agents.cubytest.space`, sólo LAN/tailnet. El plan, las decisiones de v2 y lo descartado viven en Cuby Bubble, proyecto `agents` (README y módulo «Agents v2»).

Código: [AngelMaldonado/agents](https://github.com/AngelMaldonado/agents) (privado, rama `v2`).

Viene del POC **Buyer** (oct-2026), que cotizaba compras. Hoy son agentes generales sobre Postgres + DBOS: el rol de cada uno es texto libre, la conversación continúa entre tareas y responden en markdown. Sólo modelos GPT. v2 lo vuelve una plataforma de agentes generales.

## Hacia dónde va (v2)

```
                 ┌──────────── canales (agnósticos) ────────────┐
                 │ web · cron nativo · webhook firmado por agente│
                 └───────────────────────┬───────────────────────┘
                                         │ {text, from?, attachments?, context?, new_conversation?}
                                         ▼
 navegadores ◄── /ws por tópico ── api (Bun + Hono) ── DBOS ──► Postgres (propio, en el stack)
 (persona / admin)                 │  buzón del agente → workflow «corrida»
                                   │  cola particionada por persona, prioridad admin
                                   │  webhook de salida con reintentos (24 h)
                                   │  gateway /llm/* ──► CLIProxyAPI (red interna)
                                   │  /metrics ──► Prometheus / Grafana
                                   │
                                   │ Docker API + /sandbox/ws (frames, eventos, archivos; reconexión)
                                   ▼
                 ┌──────────── reko-3 (por ahora) ───────────────┐
                 │ sandbox por corrida: pi + agent-browser/Chrome │
                 │ volumen por agente: sesión pi, workspace, perfil│
                 │ salida: internet sí; LAN, tailnet, metadata no │
                 └────────────────────────────────────────────────┘
```

## Hoy

```
Navegador (React) ── /ws: frames sólo lectura, tareas, eventos ──► server (Bun + Hono)
                                                                    │  Postgres 18: tablas de la app (public) + DBOS (dbos)
                                                                    │  vault y keys cifrados (AGENTS_MASTER_KEY)
                                                                    │  Docker API ──► agents-sandbox (uno por tarea)
                                                                    │                   supervisor.mjs
                                                                    │                   pi --mode rpc ── /llm/* ──┐
                                                                    │                   agent-browser + Chrome    │
                                                                    ◄── /sandbox/ws (frames, eventos, logins) ────┘
                                                                    └─ u<persona>/<modelo> ──► CLIProxyAPI ──► OpenAI (sólo GPT)
```

## Piezas

| Ruta | Qué es |
|---|---|
| `server/src/tasks.ts` | Corridas durables con DBOS: cola `person:<id>` (cuota de cada persona) → cola `sandboxes` (tope global, prioridad 0 para el admin); contenedor por corrida, reconexión del supervisor, eventos de pi → estados del personaje, steer, cancelar, límites |
| `server/src/db.ts`, `server/migrations/` | Postgres: pool, migraciones en orden (`NNN_*.sql`, una vez cada una) y tokens guardados como sha256 |
| `server/src/llm.ts` | Gateway LLM: el token de la tarea se vuelve el usuario y su modelo; el sandbox nunca ve una key real |
| `server/src/providers.ts` | Keys de cada persona y la config de CLIProxyAPI (prefijo `u<id>` + `force-model-prefix`) |
| `server/src/vault.ts` | Accesos a sitios: cifrados, concedidos por agente, log de cada uso |
| `server/src/people.ts` | Login por nombre, link de un solo uso, PIN de admin (como `~/dev/sonos`) |
| `sandbox/` | Imagen de la mini-computadora: pi 1.4.0, agent-browser 0.39.2, Chrome, `supervisor.mjs`, `agents-blocked`, `agents-login`, plugin `agents-vault` |
| `web/` | Galería, vista del agente, ajustes y admin (React + Vite) |
| `scripts/fake-llm.ts` | LLM falso con guion para probar sin gastar (`just dev fake on`) |

## Modelos

- **Sólo GPT**: Agents no usa Claude. Catálogo inicial: **GPT-6.1 Sol** (`openai/gpt-6.1-sol`) y **GPT-6 Sol** (`openai/gpt-6-sol`); el admin puede cambiarlo, siempre con modelos `openai/`. El gateway sólo sirve `/llm/openai/v1/responses`.
- GPT usa `/v1/responses` (necesario para herramientas en GPT-6.1 Sol); pi 1.4.0 ya incluye ambos modelos en su catálogo offline.
- Con un CLIProxyAPI propio, Agents consulta `/v1/models` antes de encolar: si no ofrece el modelo del agente, devuelve un error sin crear el contenedor. Que un modelo aparezca ahí no garantiza cuota ni acceso upstream.
- Referencia: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol).

## Memoria de un agente

Cada agente tiene un volumen Docker (`agents-<instancia>-agent-<id>`, montado en `~/state`) que se conserva entre tareas:

- `pi/`: la sesión de pi de cada conversación. La tarea siguiente continúa la conversación vigente; «Conversación nueva» la archiva y abre otra.
- `work/`: `~/work`. Se conserva; `~/work/out/` empieza vacía en cada tarea y lo que el agente deja ahí son los archivos de esa tarea.
- `browser/`: el perfil de Chrome (sesiones iniciadas, cookies, almacenamiento; la caché va a `/tmp`). Quitarle un acceso del vault borra las cookies y el almacenamiento de ese origen; «Borrar perfil del navegador» lo borra entero en su siguiente tarea.

La respuesta de una tarea es el último mensaje del agente, en markdown.

## Canales

Un agente despierta por la web, por su **webhook de entrada** (`POST /hooks/<token>`, firmado con HMAC: `X-Agents-Signature: t=…,v1=…`) o por sus **horarios** (cron de DBOS, hora de `America/Mexico_City`). Todo entra a su buzón (`server/src/inbox.ts`): si duerme, empieza una tarea; si está trabajando, es un seguimiento; si está atascado, es la respuesta. Cuando una tarea termina o se atasca, su **webhook de salida** recibe la respuesta, enlaces firmados de 7 días a los archivos y el `context` del puente, con reintentos durante ~24 h (`server/src/channels.ts`). Todo se configura en la pestaña Canales del agente. El contrato completo para quien construya un puente está en Bubble: proyecto `agents`, `docs/canales.md`.

En dev, `just dev fake on` también levanta un receptor de prueba en `http://fake-llm:8317/hook-receiver`.

## Monitor y tiempo real

- **Por tópicos** (`server/src/hub.ts`): la galería recibe el estado de las tareas y una miniatura por segundo por agente; el stream completo (~5 fps) y los eventos de una tarea sólo llegan a quien tiene abierta la vista de ese agente, y el supervisor sólo lo manda mientras alguien la mira. Al reconectar, la web vuelve a pedir lo que se perdió.
- **Monitor** (pestaña Monitor, `server/src/monitor.ts`): cada persona ve sus computadoras (CPU, RAM, red, tiempo, costo) y su lugar en la cola; el admin ve todas, el host y los huérfanos, que puede limpiar.
- **`/metrics`** en el puerto 9464 (no pasa por Traefik): corridas por estado, cola por persona, CPU y RAM por sandbox, host, costo por persona, arranque promedio e imágenes enviadas. El panel «Agents» de Grafana y sus dos alertas viven en `~/dev/work/reko-3` (`roles/monitoring/files/dashboards/cuby/agents.json`, `roles/monitoring/files/alerting/agents.yaml`, job `agents` en `prometheus_extra_scrape_configs`).

## Ejemplo de rol: compras

Lo que el POC traía cableado ahora es un rol que se pega en el agente:

> Cotizas compras para Cuby en México. Precios en MXN, sitios .mx o que envían a México, salvo que la tarea diga otra cosa. Para cada opción toma una captura de la página del producto donde se vea el precio (`~/work/out/opcion-<n>.png`) y usa sólo precios que viste. En MercadoLibre busca abriendo `https://listado.mercadolibre.com.mx/<términos-separados-por-guiones>` (no `/buscar?q=`), entra a la ficha de cada producto y cierra los avisos de cookies o ubicación si tapan el precio. Responde con una tabla: producto, tienda, precio, envío, disponibilidad, enlace y captura, y di cuál recomiendas y por qué.

## Seguridad, en corto

- El contenedor recibe un token de arranque que se quema al conectar y a cambio recibe uno de sesión, con el que se reconecta si el backend se reinicia (un deploy); muere con la corrida. Los logins de sitios viajan sólo por ese socket. pi recibe otro token que sólo sirve en `/llm/*`, para el modelo de su tarea. En la base sólo se guarda el sha256 de cada token.
- CLIProxyAPI sólo es alcanzable por el backend (red `*-internal`); los sandboxes están en otra red.
- Nadie toca el navegador ni la terminal del agente: la vista es sólo lectura; el humano hace steer o cancela.
- Los sandboxes salen a internet y a su propia red (el backend), nunca a la LAN, otras redes Docker, la tailnet, link-local/metadata ni al host. La regla es del host y vive en `~/dev/work/reko-3` (`docker_egress_lock_interfaces` y `firewall_deny_interfaces`, sobre los bridges `agents-dev-sbx` y `agents-prd-sbx`); `just sandbox egress` la verifica. Los sandboxes resuelven DNS con resolvers públicos (`AGENTS_SANDBOX_DNS`).

## Producción

- Stack `agents` de Komodo en reko-3; imágenes fijadas al commit (`IMAGE_TAG`), sin auto-update. `just deploy image` publica el server y `just deploy sandbox` construye el sandbox en reko-3; después se actualiza el compose y el tag del stack y se despliega desde Komodo.
- Datos: `/srv/agents/{data,cliproxy,postgres}`; respaldos: `/srv/agents/backups/agents-AAAA-MM-DD.dump`. El primer `pg_dump` espera a las tablas de la app y DBOS para no respaldar una base recién creada todavía vacía; luego corre cada 24 h y conserva 14 días.
- Secretos y PIN de administrador: **1Password, bóveda Cuby, ítem `agents`**. No perder `AGENTS_MASTER_KEY`: cifra las keys y el vault de la app. `.env.production` contiene el acceso operativo con prefijo `AGENTS_PROD_`, modo 600 e ignorado por git; nunca se copia al entorno de la app.
- El POC Buyer nunca se desplegó en producción: no había `/srv/buyer` ni stack `buyer`, por lo que no existe un archivo de datos del POC que restaurar. No se migran las keys ni los datos de dev; cada persona registra su credencial GPT en Ajustes.
- Panel: [Agents en Grafana](https://grafana.cubytest.space/d/cuby-agents/agents). Las alertas de Agents usan el receptor ntfy de la plataforma, tema `cuby-agents`.

## Desarrollo (todo corre en reko-3)

```bash
just dev session      # sube el entorno, abre tmux cuby-agents con el rsync en bucle y los logs
just dev up           # sólo subir (genera .env.dev en reko-3 la primera vez; PIN dev 1234)
just dev fake on|off  # LLM falso con guion en lugar de CLIProxyAPI
just sandbox build    # reconstruir la imagen del sandbox
just sandbox egress   # verificar el firewall de salida desde la red de sandboxes
just dev test         # pruebas del server contra la base agents_test del Postgres de dev
just dev psql         # consola del Postgres de dev (desechable)
just dev stop         # cerrar tmux y bajar el entorno
```

Producción: `just prod psql` abre la base en tmux `cuby-agents-prod` (túnel SSH + psql de sólo lectura, prompt `PROD`); `just prod tunnel` sólo el túnel y `just prod stop` cierra. Lee `.env.production` (copia de `.env.production.example`, chmod 600). Cambiar la cuota de alguien o el tope global tarda ~1–2 s en llegar a la cola (DBOS relee su configuración cada segundo).

https://agents-dev.cubytest.space (sólo LAN o tailnet).
