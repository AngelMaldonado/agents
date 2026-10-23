# Buyer

Agentes IA trabajadores con su propia computadora y un navegador que se ve en vivo. Primer trabajo: cotizar compras (México, MXN, sin pagar nunca). Herramienta interna de Cuby; el plan y las decisiones viven en Cuby Bubble, proyecto `buyer`.

```
Navegador (React) ── /ws: frames sólo lectura, tareas, eventos ──► server (Bun + Hono + bun:sqlite)
                                                                    │  vault y keys cifrados (BUYER_MASTER_KEY)
                                                                    │  Docker API ──► buyer-sandbox (uno por tarea)
                                                                    │                   supervisor.mjs
                                                                    │                   pi --mode rpc ── /llm/* ──┐
                                                                    │                   agent-browser + Chrome    │
                                                                    ◄── /sandbox/ws (frames, eventos, logins) ────┘
                                                                    └─ u<persona>/<modelo> ──► CLIProxyAPI ──► Anthropic / OpenAI
```

## Piezas

| Ruta | Qué es |
|---|---|
| `server/src/tasks.ts` | Cola, contenedor por tarea, eventos de pi → estados del personaje, steer, cancelar, límites |
| `server/src/llm.ts` | Gateway LLM: el token de la tarea se vuelve el usuario y su modelo; el sandbox nunca ve una key real |
| `server/src/providers.ts` | Keys de cada persona y la config de CLIProxyAPI (prefijo `u<id>` + `force-model-prefix`) |
| `server/src/vault.ts` | Accesos a sitios: cifrados, concedidos por agente, log de cada uso |
| `server/src/people.ts` | Login por nombre, link de un solo uso, PIN de admin (como `~/dev/sonos`) |
| `sandbox/` | Imagen de la mini-computadora: pi 1.4.0, agent-browser 0.39.2, Chrome, `supervisor.mjs`, `buyer-blocked`, `buyer-login`, plugin `buyer-vault` |
| `web/` | Galería, vista del agente, ajustes y admin (React + Vite) |
| `scripts/fake-llm.ts` | LLM falso con guion para probar sin gastar (`just dev fake on`) |

## Modelos

- Catálogo inicial: Claude Sonnet 4.6, Claude Haiku 4.5, **GPT-6.1 Sol** (`openai/gpt-6.1-sol`) y **GPT-6 Sol** (`openai/gpt-6-sol`). El admin puede cambiarlo.
- GPT usa `/v1/responses` (necesario para herramientas en GPT-6.1 Sol); pi 1.4.0 ya incluye ambos modelos en su catálogo offline.
- Con un CLIProxyAPI propio, Buyer consulta `/v1/models` antes de encolar: si no ofrece el modelo del agente, devuelve un error sin crear el contenedor. Que un modelo aparezca ahí no garantiza cuota ni acceso upstream.
- Referencia: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol).

## Seguridad, en corto

- El contenedor recibe un token de arranque que se quema al conectar; los logins de sitios viajan sólo por ese socket. pi recibe otro token que sólo sirve en `/llm/*`, para el modelo de su tarea.
- CLIProxyAPI sólo es alcanzable por el backend (red `*-internal`); los sandboxes están en otra red.
- Nadie toca el navegador ni la terminal del agente: la vista es sólo lectura; el humano hace steer o cancela.
- Pendiente conocido: los sandboxes todavía pueden alcanzar la LAN de reko-3 (falta regla en `DOCKER-USER`).

## Desarrollo (todo corre en reko-3)

```bash
just dev session      # sube el entorno, abre tmux cuby-buyer con el rsync en bucle y los logs
just dev up           # sólo subir (genera .env.dev en reko-3 la primera vez; PIN dev 1234)
just dev fake on|off  # LLM falso con guion en lugar de CLIProxyAPI
just sandbox build    # reconstruir la imagen del sandbox
just dev stop         # cerrar tmux y bajar el entorno
```

https://agents-dev.cubytest.space (sólo LAN o tailnet).
