# Release de Agents

`just release` (desde `wip`) es la autorización para publicar **y desplegar**: no pide confirmación. Todo lo dispara ese comando desde la Mac; nada en Komodo escucha pushes ni webhooks, y no hace falta `just dev` arriba. El código: [`scripts/release/release.ts`](../scripts/release/release.ts).

## Flujo

```text
Mac   wip limpio y no detrás de origin/wip · API key de Komodo (1Password) · ve los stacks agents y agents-firma
Mac   just sanitize history · format check · lint · check            (rápido, sin base de datos)
reko-5  git archive <sha> | buildx build --push                    agents-app, agents-sandbox, agents-proxy :<sha12>
reko-5  scripts/ci/e2e.sh contra ESAS imágenes                     red propia en el bridge bloqueado agents-dev-sbx,
        PostgreSQL desechable, la app real arranca y /healthz, pruebas del servidor con base, E2E de diseño y de compartir
Mac   git push wip
Komodo  stack de un solo uso agents-firma: cosign sign -a git_sha=<sha> con la llave de sus variables; se destruye
reko-5  cosign verify contra release/cosign.pub (llave, digest y git_sha) · :beta → ese digest
Komodo  deploy/agents.compose.yaml del commit → stack agents (sólo el compose; el Environment no se toca) · Deploy
Mac   espera a que https://agents.cubytest.space/healthz diga ready y el sha del commit
```

Si algo falla se detiene ahí: antes de la firma no hay nada publicado (sólo imágenes `:<sha12>` sin firma en Zot, que nadie usa); después, el mensaje dice en qué paso quedó. El diff entre el compose que tiene Komodo y el del commit se imprime antes de aplicarlo.

**Volver atrás**: `just release <sha12>` verifica las firmas de las imágenes de ese commit, mueve `:beta` a ellas y despliega el compose de ese commit.

**Versión**: no hay tags ni releases de GitHub; la versión es el commit. `/healthz` dice `version` (sha de 12) y `sha` (completo); las imágenes llevan `org.opencontainers.image.revision` (sha) y `org.opencontainers.image.version` (sha de 12). Por eso «Computadora → Versiones» ya no enlaza notas de GitHub en imágenes nuevas: compara imágenes por su ID, como siempre.

El CI de GitHub (`.github/workflows/checks.yml`) sigue igual para PRs y pushes a `main`, pero el release no depende de él.

## Runners de CI (reko-3)

Los tres jobs piden `runs-on: [self-hosted, linux, x64, agents]`. Los runners de GitHub no arrancan mientras la cuenta tenga un bloqueo de facturación («your account is locked due to a billing issue»), aunque el repo sea público. Se administran con Runner Fleet (`~/dev/work/runners`, un runner por contenedor). Lo que necesita un runner de este repo:

| Qué                                                                                                                                               | Por qué                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registrado en `AngelMaldonado/agents`, con el label `agents`                                                                                      | Así lo eligen los jobs; ningún otro repo debe usarlo.                                                                                                                                                                                                             |
| `linux/amd64`                                                                                                                                     | El E2E construye imágenes `--platform linux/amd64` y `just` se descarga para x86_64.                                                                                                                                                                              |
| Docker: el Docker in Docker de Runner Fleet (por omisión, `DOCKER_HOST=tcp://runner-dind:2375`) o el del host (`job_docker_backend: host-socket`) | `scripts/ci/postgres.sh` deja la base donde el job la alcanza (en el DinD, en un puerto libre: lo comparten los runners de varios repos) y el E2E copia el repo a su contenedor en vez de montarlo, así que no depende de que el daemon vea las rutas del runner. |
| BuildKit                                                                                                                                          | El Dockerfile del sandbox usa `COPY --chmod`; el workflow instala buildx (versión y checksum fijos) si el runner no lo trae.                                                                                                                                      |
| `curl`, `git`, `python3`, `docker` CLI (la imagen base de Runner Fleet, alineada con `ubuntu-24.04`)                                              | Bun, Node y just los instala el propio workflow.                                                                                                                                                                                                                  |
| Al menos ~8 GB de disco libre para imágenes de prueba                                                                                             | El E2E construye la imagen del sandbox (Chrome) y la de la app, y las borra al terminar.                                                                                                                                                                          |

Un ejemplo de entrada en el `config.yaml` de Runner Fleet:

```yaml
runners:
  container_mode: true
  items:
    - name: agents-1
      target_type: repo
      target: AngelMaldonado/agents
      labels: [agents] # GitHub fija los labels al registrar: en uno ya registrado, agrégalo en Settings → Runners o por la API
      # job_docker_backend: dind (por omisión) o host-socket; los dos sirven
```

Los runners propios ejecutan el código que corre en ellos con acceso a un Docker de reko-3, y el repo es público. Por eso una PR desde un fork nunca debe llegar a ellos:

- Los jobs que van al runner corren sólo para pushes a `main`, lanzamientos a mano (`workflow_dispatch`) y PRs de ramas de este mismo repo (su `if`).
- Eso no basta solo: una PR de fork corre el workflow que trae, editado si quiere. Lo que de verdad lo cierra es GitHub: **Settings → Actions → General → «Require approval for all external contributors»** (API: `actions/permissions/fork-pr-contributor-approval` = `all_external_contributors`). Nunca apruebes el workflow de una PR de fork sin leer qué cambia en `.github/`. Comparten daemon con Komodo y con los sandboxes de prueba de dev; los contenedores de CI llevan etiquetas propias (`agents.ci`, la red del E2E) y se borran al terminar. Nunca se deben podar imágenes del host: los agentes aprobados fijan IDs inmutables.

El Mac coordina mediante `gh` y la API Komodo, usando versiones de herramientas/dependencias fijadas. No construye imágenes ni recibe la clave privada de firma. No hay runner JIT, workflow de publicación ni servidor Git temporal. El proceso debe seguir abierto para completar la publicación; una desconexión no revierte ni necesariamente cancela operaciones remotas.

## Recursos Komodo (reko-5)

- Stack **`agents`**: producción. El release sólo reescribe su compose (`file_contents`) y lo despliega; su Environment (PIN, llaves, contraseñas, CA del proxy) se administra a mano.
- Stack **`agents-firma`**: vacío entre releases (`services: {}`, sin Environment), en el servidor reko-5. El release lo llena con el compose de cosign y `[[COSIGN_PRIVATE_KEY_B64]]`/`[[COSIGN_PASSWORD]]`, lo despliega, y al terminar lo destruye, vacía su Environment y borra su `.env` de `/etc/komodo/stacks/agents-firma/` dentro de `komodo-periphery-1`.
- Variables **`COSIGN_PRIVATE_KEY_B64`** y **`COSIGN_PASSWORD`**: la llave de firma de la organización (la misma de asterion; su pública es `release/cosign.pub`, huella `cosignPublicKeySha256` de `release/config.json`).
- La API key del ítem de 1Password necesita **Read + Write + Execute** sobre los dos stacks. Nada más.
- Los Repos `agents-app`, `agents-sandbox` y `agents-proxy` del flujo anterior ya no se usan.

## Credenciales

- 1Password, bóveda **Cuby**, ítem **Agents Release**, campos `key` y `secret`: sólo a memoria del proceso y tapados en lo que se imprime. Sin 1Password: `AGENTS_RELEASE_KOMODO_KEY` y `AGENTS_RELEASE_KOMODO_SECRET`.
- El registry (`registry.cubytest.space`): la sesión de Docker de reko-5 (`~/.docker/config.json`), que también montan la firma y la verificación (sólo lectura).
- La llave privada de cosign nunca sale de Komodo ni pasa por la Mac.

## Requisitos de reko-5

- El bloqueo de salida del host cubre `agents-dev-sbx` (y `agents-prd-sbx`): `~/dev/work/reko-3/inventory/host_vars/reko-5/main.yml`. Las computadoras de prueba quedan igual de aisladas que las de producción; el runner y la app de prueba usan DNS públicos.
- Docker con buildx y unos 10 GB libres para las tres imágenes y la red de prueba.
- Un release a la vez: `agents-release.lock` en el directorio de git (el bridge de prueba y el stack de firma son únicos).
