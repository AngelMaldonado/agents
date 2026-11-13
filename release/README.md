# Release de Agents

`just release` es autorización para integrar y publicar: **no pide `PUBLICAR` ni confirmación interactiva**. No despliega, migra datos ni cambia dominios. La preparación nunca ejecuta la publicación del baseline.

## Flujo

```text
Mac: calidad → push wip → PR/Required checks → merge protegido sin prompt
     → esperar CI del SHA integrado → checkout temporal main → versión
     → Komodo agents-app: build → push → sign → verify
     → Komodo agents-sandbox: build → push → sign → verify
     → tag/prerelease GitHub y manifest → registros locales
```

GitHub conserva un único workflow de CI: Quality con PostgreSQL temporal y Sandbox E2E con app/pi/Chrome reales y GPT simulado. `Required checks` exige ambos exitosos; no admite skipped. Se mantiene CI sobre la PR y sobre el commit integrado. El plan GitHub no ofrece reviewers obligatorios de entorno privado; no se simulan.

El repositorio es **público** y `main` exige `Required checks` por protección de ramas. Si GitHub no ofreciera protección (un repo privado en el plan gratuito responde 403), `just release` exige los checks de `release/config.json` (`requiredChecks`) y vuelve a esperar `Required checks` del SHA integrado después del merge: nunca integra sin ellos.

## Runners de CI (reko-3)

Quality y Sandbox E2E piden `runs-on: [self-hosted, linux, x64, agents]`; `Required checks` sólo compara sus resultados y corre en `ubuntu-24.04`. Se administran con Runner Fleet (`~/dev/work/runners`, un runner por contenedor). Lo que necesita un runner de este repo:

| Qué                                                                                                  | Por qué                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registrado en `AngelMaldonado/agents`, con el label `agents`                                         | Así lo eligen los jobs; ningún otro repo debe usarlo.                                                                                                          |
| `linux/amd64`                                                                                        | El E2E construye imágenes `--platform linux/amd64` y `just` se descarga para x86_64.                                                                           |
| Docker del host (`job_docker_backend: host-socket`), no DinD                                         | Quality levanta su PostgreSQL en la red del propio contenedor del runner (`scripts/ci/postgres.sh`) y el E2E monta `/var/run/docker.sock` en sus contenedores. |
| Su directorio de trabajo montado **en la misma ruta** dentro del contenedor y en reko-3              | El E2E monta `-v "$PWD:/app"`: el daemon del host resuelve esa ruta en el host.                                                                                |
| `curl`, `git`, `python3`, `docker` CLI (la imagen base de Runner Fleet, alineada con `ubuntu-24.04`) | Bun, Node y just los instala el propio workflow.                                                                                                               |
| Al menos ~8 GB de disco libre para imágenes de prueba                                                | El E2E construye la imagen del sandbox (Chrome) y la de la app, y las borra al terminar.                                                                       |

Un ejemplo de entrada en el `config.yaml` de Runner Fleet:

```yaml
runners:
  container_mode: true
  items:
    - name: agents-1
      target_type: repo
      target: AngelMaldonado/agents
      labels: [agents]
      job_docker_backend: host-socket
```

Los runners propios ejecutan el código que corre en ellos con acceso al Docker de reko-3, y el repo es público. Por eso una PR desde un fork nunca debe llegar a ellos:

- Los jobs que van al runner corren sólo para pushes a `main`, lanzamientos a mano (`workflow_dispatch`) y PRs de ramas de este mismo repo (su `if`).
- Eso no basta solo: una PR de fork corre el workflow que trae, editado si quiere. Lo que de verdad lo cierra es GitHub: **Settings → Actions → General → «Require approval for all external contributors»** (API: `actions/permissions/fork-pr-contributor-approval` = `all_external_contributors`). Nunca apruebes el workflow de una PR de fork sin leer qué cambia en `.github/`. Comparten daemon con Komodo y con los sandboxes de prueba de dev; los contenedores de CI llevan etiquetas propias (`agents.ci`, la red del E2E) y se borran al terminar. Nunca se deben podar imágenes del host: los agentes aprobados fijan IDs inmutables.

El Mac coordina mediante `gh` y la API Komodo, usando versiones de herramientas/dependencias fijadas. No construye imágenes ni recibe la clave privada de firma. No hay runner JIT, workflow de publicación ni servidor Git temporal. El proceso debe seguir abierto para completar la publicación; una desconexión no revierte ni necesariamente cancela operaciones remotas.

## Recursos Komodo

El diseño final tiene **dos Repos ejecutores**, no Builds nativos ni servicios persistentes:

| Recurso          | Contexto   | Imagen de producto                                  |
| ---------------- | ---------- | --------------------------------------------------- |
| `agents-app`     | `.`        | `registry.cubytest.space/cuby/agents-app:<SHA>`     |
| `agents-sandbox` | `sandbox/` | `registry.cubytest.space/cuby/agents-sandbox:<SHA>` |

Ambos clonan `AngelMaldonado/agents` directamente por HTTPS con la cuenta Git provider **`AngelMaldonado`**, seleccionada por nombre. El token se resuelve y usa en Komodo/reko-3: no se exporta al Mac, imprime ni copia a archivos locales; tampoco se amplían las credenciales de otros perfiles. No hay webhooks. Cada ejecución recibe SHA completo y versión; valida fuente limpia, plataforma linux/amd64, labels y firma del digest exacto.

Komodo 2.3.3 sólo tiene `pre_build`, no hook posterior para firma. Para cumplir el límite de dos recursos se usa un script común `scripts/release/komodo-job.sh` en `on_pull`, dejando `on_clone` vacío: CloneRepo también ejecuta on_pull. El script usa tres contenedores temporales de la misma imagen auxiliar `agents-release-tools`, fijada mediante referencia descargable `registry.cubytest.space/cuby/agents-release-tools@sha256:…`: build, sign, verify. Un ID local `sha256:…` no basta: el segundo intento real de Angel falló porque esa imagen ya no estaba en el daemon de reko-3 (mismo daemon para Komodo y host; no se determinó quién la eliminó). El ejecutor ahora autentica y descarga el digest exacto antes de las fases, sin depender de que sobreviva la caché local, y rechaza IDs locales/tags o repositorios distintos. La configuración Docker de esta descarga está en un directorio temporal privado fuera del repo, se elimina antes de arrancar las fases y también al fallar login/pull; no modifica las credenciales permanentes del host. Sólo sign recibe la clave privada y contraseña; build y verify no las reciben. La autenticación de registry de cada fase se guarda en tmpfs del contenedor; la descarga inicial usa el directorio temporal descrito arriba. Las contraseñas no van en capas, build args ni argv; login recibe la contraseña por stdin. El envfile temporal git-internal se borra inmediatamente después de cargarlo, antes de montar el repo en cualquier contenedor; un trap lo elimina también si falla la carga. La auditoría detectó que borrarlo sólo al terminar dejaba sus valores accesibles por archivo en el montaje readonly de build/verify; no hubo exportación fuera de reko-3 y se corrigió antes de habilitar publicación.

Estos ejecutores tienen Docker socket y ejecutan código aprobado con autoridad sobre el host. No son un sandbox ni una frontera fuerte de seguridad. No montan datos de usuarios; nunca se debe podar imágenes, porque los agentes aprobados fijan IDs inmutables.

## Credenciales

- API Komodo: cuenta de servicio `agents-release`, sólo Write sobre los dos Repos y Read de metadatos del servidor. Retirados sus permisos a los cuatro recursos previos y al Builder. Eliminados los dos secretos API del entorno GitHub y revocada la clave anterior `agents-release-github`; sólo queda `agents-release-mac`. El Mac carga `key` y `secret` desde **1Password / Cuby / Agents Release**, por stdin/memoria, sin archivos locales ni valores en argv. No es el token GitHub ni la clave Cosign.
- GitHub del Mac: autenticación existente de `gh`; se usa para PR, merge, checks, tags y release.
- GitHub de Komodo: cuenta Git provider existente `AngelMaldonado`, autorizada expresamente por Angel. No se exporta su token al Mac.
- Cosign y registry: referencias `[[COSIGN_PRIVATE_KEY_B64]]`, `[[COSIGN_PASSWORD]]`, `[[REGISTRY_USERNAME]]`, `[[REGISTRY_PASSWORD]]` resueltas sólo en Komodo.

## Firma y versión

Cosign 3.1.4 fijado por checksum. Clave pública `release/cosign.pub`, huella SHA-256 `306102f7485320db8a37e90babb847b7f99e5910775d292d6a44801736475859`. Política explícita `transparencyLog=false`, sin Rekor público; mantiene verificación criptográfica de clave, anotaciones SHA/versión y digest. Flags compatibles compartidos en `cosign.mjs`; no se presupone compatibilidad de versiones futuras.

El tag Docker es el SHA completo integrado; no hay `latest` ni tags semver Docker. Primera versión GitHub exacta `v0.0.1-beta`, sólo después de verificar ambas imágenes. Después cada beta sube el patch: `v0.0.1-beta` → `v0.0.2-beta` → `v0.0.3-beta` (`nextBeta` en `scripts/release/version.mjs`; `-beta` nombra la etapa, sin `-beta.N`). Publica sólo si desde la última tag hay un commit `feat`, `fix`, `perf`, `build`, `ci`, `refactor`, `chore(release)` o un cambio incompatible (`releasable`); el tipo no cambia el número. Salir de `0.0.x` es una decisión explícita. La versión ya no la calcula semantic-release (se quitó); cada tag conserva la nota de canal `beta` sobre su commit, así la historia sigue siendo legible por semantic-release. Sin cambios publicables, no hay builds/tag/release nuevos.

El manifest incluye referencias por digest, versión, SHA, plataforma y hash/lista de archivos de migración. No representa el estado de una base viva. El publisher corre desde un checkout temporal limpio de main; no modifica el checkout dev ni cambia de rama el worktree de trabajo.

## Validación y activación

Ensayo de recuperación de tools APROBADO sobre `c2e2169e9360f475f1262c5c507c963272790f68`: ambos jobs autenticaron y descargaron el digest desde el registry antes de construir/firmar/verificar. App update `6ae5465a5c3077fa6f9da82b`, sandbox `6ae546725c3077fa6f9da833`; referencias y digests exactos en [tools-recovery-proof.json](tools-recovery-proof.json). Sólo namespaces probe; no se borraron imágenes para simular una caché vacía ni se presenta el pull real como una prueba de daemon vacío. La regresión de shell exige siempre login/pull antes de las fases y abortado/limpieza al fallar cada paso. Bootstrap de la auxiliar: `6ae545085c3077fa6f9da7e4`, sin clave de firma ni cuentas adicionales. Recursos de ensayo restablecidos a ociosos, sin hooks/inputs; publicación del producto y despliegue no ejecutados por el asistente.

Ensayo anterior completo APROBADO sobre `2c3c15865d2ba5d505eadffb3fa0ff7907e1a218`, repetido después de corregir el envfile: ambos Repos clonaron con `AngelMaldonado`, construyeron linux/amd64 y firmaron/verificaron por digest con la clave pública fijada. Evidencia pública persistente: [setup-proof.json](setup-proof.json), con SHA, plataforma, esquema, digests e IDs de ejecución Komodo. App: `6ae52d0d5c3077fa6f9da2fe`; sandbox: `6ae52d185c3077fa6f9da300`. Sólo se publicaron imágenes de ensayo `agents-release-probe*`, no tags/releases del producto. Los tests de release comprueban que el archivo ya no exista al invocar Docker en ninguna fase y que se elimine incluso al fallar la carga; también se exigen Quality y Sandbox E2E antes de habilitar la variable de publicación.

El 403 inicial se diagnosticó usando el token únicamente dentro de un contenedor temporal en reko-3: GitHub identificaba correctamente al usuario, pero no permitía ver el repo privado. Tras actualizar su acceso al repositorio, clon y ensayo pasaron. No se exportó el token al Mac. La primera limpieza se detuvo por autorización de 1Password agotada; se reintentó con éxito una vez disponible.

Retirados los cuatro recursos anteriores (`agents-release-app`, `agents-release-sandbox`, `agents-release-sign`, `agents-release-verify`), sus permisos, acceso al Builder y credencial API vieja. No se borraron imágenes ni se tocaron stacks de usuarios. Sólo quedan los dos Repos nuevos para este pipeline, sin webhooks, hooks ni inputs residuales de ensayo; el coordinador los configura para cada SHA aprobado. Runner JIT, snapshot HTTP y workflow de publicación ya no forman parte del flujo. La publicación se habilita con flag versionado y variable GitHub después del ensayo/CI; despliegue permanece false. Durante la preparación no se ejecutó `just release` ni se emitió `v0.0.1-beta`.

Evidencia histórica de la arquitectura anterior: [ensayo real app+sandbox build/sign/verify](https://github.com/AngelMaldonado/agents/actions/runs/41119238161) y [CI 75ea2f8](https://github.com/AngelMaldonado/agents/actions/runs/41121510012). No sustituyen la validación del flujo nuevo.

**Incidente previo de inventario:** una consulta admin inicial devolvió material secreto a memoria del Mac antes de filtrar salida. No se escribió en archivos, logs ni commits, pero incumplió el límite de mantenerlo en Komodo; fue notificado y documentado en Bubble #16. La consulta se retiró y no se rotó la clave compartida sin autorización. El nuevo flujo no requiere esa lectura.

## Operación y recuperación

```bash
cd /Users/amald/dev/work/agents-release-setup
just release plan  # sólo explica; no opera remotamente
just release       # integra y publica SIN pedir confirmación; no despliega
```

Logs redactados en `.release/` (gitignored, 0600), más IDs/logs Komodo y JSON de resultado/manifest copiados del checkout temporal, incluso si falla después del build. Subprocesses Mac acotados a 75 min, operación Komodo a 30, comandos del helper a 20. Un timeout puede dejar trabajo remoto activo: revisar IDs antes de reintentar. Un merge o tag publicado no se revierte automáticamente; un fallo al adjuntar manifest exige conciliar la release existente, no repetir bootstrap a ciegas.

Primer intento real de Angel: PR #1 integrada en `06582c79b385869284eab3e416c0dd109011ee5c` y CI de main aprobado; el publisher se detuvo antes de builds/tags/releases porque el enlace de dependencias aparecía como `?? node_modules`. El patrón `node_modules/` sólo ignoraba directorios, no symlinks. Corregido a `node_modules`, conservando el chequeo estricto de fuente limpia. Una regresión reproduce clon temporal + enlace y exige seguir detectando cambios tracked y archivos inesperados. Tras incorporar el fix, reejecutar `just release` desde wip: reutiliza/abre la PR del arreglo, integra de forma protegida y vuelve a validar main; no revierte el merge anterior ni inventa otro baseline. Si ya existe algún tag/release al reintentar, conciliar antes, no forzar publicación.

Fuera de alcance: stack `agents` y su .env, PostgreSQL de usuarios, conversaciones, cuentas, sesiones, volúmenes, dominios, corte y rollback de despliegue. WhatsApp sigue excluido por gate estático, conservando código y migración histórica. `deploy/release.compose.yaml` sólo es referencia futura, no un stack listo para aplicar.
