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

GitHub conserva un único workflow de CI: Quality con PostgreSQL temporal y Sandbox E2E con app/pi/Chrome reales y GPT simulado. `Required checks` exige ambos exitosos; no admite skipped. Se mantiene CI sobre la PR y sobre el commit integrado. Se conservaron PRs obligatorias, administradores incluidos, sin force push ni bypass. El plan GitHub no ofrece reviewers obligatorios de entorno privado; no se simulan.

El Mac coordina mediante `gh` y la API Komodo, usando versiones de herramientas/dependencias fijadas. No construye imágenes ni recibe la clave privada de firma. No hay runner JIT, workflow de publicación ni servidor Git temporal. El proceso debe seguir abierto para completar la publicación; una desconexión no revierte ni necesariamente cancela operaciones remotas.

## Recursos Komodo

El diseño final tiene **dos Repos ejecutores**, no Builds nativos ni servicios persistentes:

| Recurso          | Contexto   | Imagen de producto                                  |
| ---------------- | ---------- | --------------------------------------------------- |
| `agents-app`     | `.`        | `registry.cubytest.space/cuby/agents-app:<SHA>`     |
| `agents-sandbox` | `sandbox/` | `registry.cubytest.space/cuby/agents-sandbox:<SHA>` |

Ambos clonan `AngelMaldonado/agents` directamente por HTTPS con la cuenta Git provider **`AngelMaldonado`**, seleccionada por nombre. El token se resuelve y usa en Komodo/reko-3: no se exporta al Mac, imprime ni copia a archivos locales; tampoco se amplían las credenciales de otros perfiles. No hay webhooks. Cada ejecución recibe SHA completo y versión; valida fuente limpia, plataforma linux/amd64, labels y firma del digest exacto.

Komodo 2.3.3 sólo tiene `pre_build`, no hook posterior para firma. Para cumplir el límite de dos recursos se usa un script común `scripts/release/komodo-job.sh` en `on_pull`, dejando `on_clone` vacío: CloneRepo también ejecuta on_pull. El script usa tres contenedores temporales de la misma imagen auxiliar inmutable `release-tools`, fijada por ID: build, sign, verify. Sólo sign recibe la clave privada y contraseña; build y verify no las reciben. Registry auth se guarda exclusivamente en tmpfs del contenedor, no en capas ni build args. El envfile temporal git-internal se borra inmediatamente después de cargarlo, antes de montar el repo en cualquier contenedor; un trap lo elimina también si falla la carga. La auditoría detectó que borrarlo sólo al terminar dejaba sus valores accesibles por archivo en el montaje readonly de build/verify; no hubo exportación fuera de reko-3 y se corrigió antes de habilitar publicación.

Estos ejecutores tienen Docker socket y ejecutan código aprobado con autoridad sobre el host. No son un sandbox ni una frontera fuerte de seguridad. No montan datos de usuarios; nunca se debe podar imágenes, porque los agentes aprobados fijan IDs inmutables.

## Credenciales

- API Komodo: cuenta de servicio `agents-release`, sólo Write sobre los dos Repos y Read de metadatos del servidor. Retirados sus permisos a los cuatro recursos previos y al Builder. Eliminados los dos secretos API del entorno GitHub y revocada la clave anterior `agents-release-github`; sólo queda `agents-release-mac`. El Mac carga `key` y `secret` desde **1Password / Cuby / Agents Release**, por stdin/memoria, sin archivos locales ni valores en argv. No es el token GitHub ni la clave Cosign.
- GitHub del Mac: autenticación existente de `gh`; se usa para PR, merge, checks, tags y release.
- GitHub de Komodo: cuenta Git provider existente `AngelMaldonado`, autorizada expresamente por Angel. No se exporta su token al Mac.
- Cosign y registry: referencias `[[COSIGN_PRIVATE_KEY_B64]]`, `[[COSIGN_PASSWORD]]`, `[[REGISTRY_USERNAME]]`, `[[REGISTRY_PASSWORD]]` resueltas sólo en Komodo.

## Firma y versión

Cosign 3.1.4 fijado por checksum. Clave pública `release/cosign.pub`, huella SHA-256 `306102f7485320db8a37e90babb847b7f99e5910775d292d6a44801736475859`. Política explícita `transparencyLog=false`, sin Rekor público; mantiene verificación criptográfica de clave, anotaciones SHA/versión y digest. Flags compatibles compartidos en `cosign.mjs`; no se presupone compatibilidad de versiones futuras.

El tag Docker es el SHA completo integrado; no hay `latest` ni tags semver Docker. Primera versión GitHub exacta `v0.0.1-beta`, sólo después de verificar ambas imágenes. Después semantic-release calcula betas según Conventional Commits; un fixture con tag anotado y nota sobre el commit verifica `0.0.1-beta` → `0.0.1-beta.1`. Sin cambios publicables, no hay builds/tag/release nuevos.

El manifest incluye referencias por digest, versión, SHA, plataforma y hash/lista de archivos de migración. No representa el estado de una base viva. El publisher corre desde un checkout temporal limpio de main; no modifica el checkout dev ni cambia de rama el worktree de trabajo.

## Validación y activación

Ensayo real completo APROBADO sobre `2c3c15865d2ba5d505eadffb3fa0ff7907e1a218`, repetido después de corregir el envfile: ambos Repos clonaron con `AngelMaldonado`, construyeron linux/amd64 y firmaron/verificaron por digest con la clave pública fijada. Evidencia pública persistente: [setup-proof.json](setup-proof.json), con SHA, plataforma, esquema, digests e IDs de ejecución Komodo. App: `6ae52d0d5c3077fa6f9da2fe`; sandbox: `6ae52d185c3077fa6f9da300`. Sólo se publicaron imágenes de ensayo `agents-release-probe*`, no tags/releases del producto. Los tests de release comprueban que el archivo ya no exista al invocar Docker en ninguna fase y que se elimine incluso al fallar la carga; también se exigen Quality y Sandbox E2E antes de habilitar la variable de publicación.

El 403 inicial se diagnosticó usando el token únicamente dentro de un contenedor temporal en reko-3: GitHub identificaba correctamente al usuario, pero no permitía ver el repo privado. Tras actualizar su acceso al repositorio, clon y ensayo pasaron. No se exportó el token al Mac. La primera limpieza se detuvo por autorización de 1Password agotada; se reintentó con éxito una vez disponible.

Retirados los cuatro recursos anteriores (`agents-release-app`, `agents-release-sandbox`, `agents-release-sign`, `agents-release-verify`), sus permisos, acceso al Builder y credencial API vieja. No se borraron imágenes ni se tocaron stacks de usuarios. Sólo quedan los dos Repos nuevos para este pipeline, sin webhooks, hooks ni inputs residuales de ensayo; el coordinador los configura para cada SHA aprobado. Runner JIT, snapshot HTTP y workflow de publicación ya no forman parte del flujo. La publicación se habilita con flag versionado y variable GitHub después del ensayo/CI; despliegue permanece false. No se ha ejecutado `just release` ni emitido `v0.0.1-beta`.

Evidencia histórica de la arquitectura anterior: [ensayo real app+sandbox build/sign/verify](https://github.com/AngelMaldonado/agents/actions/runs/41119238161) y [CI 75ea2f8](https://github.com/AngelMaldonado/agents/actions/runs/41121510012). No sustituyen la validación del flujo nuevo.

**Incidente previo de inventario:** una consulta admin inicial devolvió material secreto a memoria del Mac antes de filtrar salida. No se escribió en archivos, logs ni commits, pero incumplió el límite de mantenerlo en Komodo; fue notificado y documentado en Bubble #16. La consulta se retiró y no se rotó la clave compartida sin autorización. El nuevo flujo no requiere esa lectura.

## Operación y recuperación

```bash
cd /Users/amald/dev/work/agents-release-setup
just release plan  # sólo explica; no opera remotamente
just release       # integra y publica SIN pedir confirmación; no despliega
```

Logs redactados en `.release/` (gitignored, 0600), más IDs/logs Komodo y JSON de resultado/manifest copiados del checkout temporal, incluso si falla después del build. Subprocesses Mac acotados a 75 min, operación Komodo a 30, comandos del helper a 20. Un timeout puede dejar trabajo remoto activo: revisar IDs antes de reintentar. Un merge o tag publicado no se revierte automáticamente; un fallo al adjuntar manifest exige conciliar la release existente, no repetir bootstrap a ciegas.

Fuera de alcance: stack `agents` y su .env, PostgreSQL de usuarios, conversaciones, cuentas, sesiones, volúmenes, dominios, corte y rollback de despliegue. WhatsApp sigue excluido por gate estático, conservando código y migración histórica. `deploy/release.compose.yaml` sólo es referencia futura, no un stack listo para aplicar.
