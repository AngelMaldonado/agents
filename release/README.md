# Release beta: publicación manual, sin despliegue

La preparación no publica `v0.0.1-beta` ni altera los entornos con usuarios. La persona publica ejecutando `just release` y confirmando `PUBLICAR`. Un push a `main` no publica. `deploymentEnabled` permanece en `false` y no existe una operación de despliegue en el coordinador.

## Uso

```bash
cd /Users/amald/dev/work/agents-release-setup
just release plan  # Sólo explica: no llama servicios remotos.
just release       # Calidad, PR/checks, confirmación y publicación manual.
```

El checkout debe estar limpio en `wip`. El comando no instala herramientas del sistema, hace commits, formatea, agrega archivos al índice ni omite protecciones. Necesita las herramientas ya preparadas en el Mac: Node, Bun, just, gh autenticado y Docker con contexto explícito `reko-3`. Las dos imágenes auxiliares inmutables deben seguir presentes en reko-3; el preflight falla antes de integrar si faltan. No requiere Cosign ni una clave privada en el Mac.

```
Mac / wip: calidad → push → PR → Required checks → PUBLICAR
                                                     │
                                            merge protegido / main
                                                     │
                                  runner JIT exclusivo de un solo job
                                  sin socket Docker ni volúmenes de usuarios
                                                     │
                             workflow_dispatch + SHA integrado exacto
                                                     │
                                   checks del commit integrado
                                                     │
                             snapshot Git efímero en red Komodo privada
                                                     │
                        Komodo: build app + sandbox, linux/amd64
                                                     │
                          firma y verificación por clave / digest
                                                     │
                         tag + prerelease + release-manifest.json
                                                     │
                                  FIN: sin deploy ni migración
```

## Ramas y aprobación

- `wip` es continua. Se integra con merge normal, no squash/rebase, sin forzar su historial. CI valida Conventional Commits nuevos y título de PR.
- `main` publica prereleases beta. `stable` es una rama ordinaria protegida e inactiva, requerida por semantic-release; no publica estable en esta fase. `v2` queda intacta porque los entornos actuales pueden referenciarla.
- Primer release exacto: `v0.0.1-beta`. Los siguientes los calcula semantic-release, restringido a `0.x-beta`; no se inventa un `1.0.0` inicial. La nota del canal beta se adjunta al commit, no al objeto del tag anotado.
- Son necesarios `publicationEnabled=true` versionado, `AGENTS_RELEASE_ENABLED=true` en GitHub y dispatch manual con el SHA aprobado. Ninguna variable de entorno salta el bloqueo versionado.
- `main`/`stable` exigen PR, `Required checks` al día y conversaciones resueltas; sin force push, borrado ni bypass de admin. El número de approving reviews es cero. El plan privado actual no permite required reviewers de environments (GitHub devolvió 422); no se presenta esa protección como existente.
- El environment `agents-release` sólo admite `main`. El workflow y el publisher verifican evento manual, rama y SHA. La concurrencia global serializa releases. Un intento tiene un runner/etiqueta aleatorio y un nombre de workflow únicos para no confundirlo con intentos anteriores del mismo SHA.

## Executor y origen del código

`just release` crea mediante GitHub un runner JIT de un solo job y lo arranca en reko-3 desde el ID fijado en `config.json`. No se instala un servicio persistente ni se guarda un PAT personal allí. El contenedor corre como usuario no root, sin Docker socket, host mounts ni puertos publicados, con límites de CPU/memoria/procesos y vida máxima de 75 minutos. Tiene acceso a la red privada `komodo_komodo`, necesario para el plano de release; no es un sandbox para código de PRs o agentes.

Checkout usa el token temporal del job. Para el push del tag/notes del bootstrap, checkout v6 conserva sus credenciales temporales fuera del almacén de objetos Git. El origen que consume Komodo es un clon bare nuevo: no copia configuración de autenticación y se comprueba que no contenga credential helpers, extraheaders ni includeIf. Se ofrece por HTTP **sólo dentro de la red Docker privada**, sin publicar un puerto del host; no entrega el token a Komodo. La rama interna `approved` apunta al mismo SHA completo. El servidor y su snapshot desaparecen con el runner.

No se amplían credenciales GitHub compartidas para que puedan leer este repo privado. Los checks ordinarios de PR siguen en runners desechables de GitHub. La excepción de ensayo inicial usa un SHA autorizado exacto y credenciales temporales de setup, retiradas al terminar.

## Recursos Komodo y confianza

- Cuenta de servicio `agents-release`: Write sólo en los Builds `agents-release-app`, `agents-release-sandbox` y Repos `agents-release-sign`, `agents-release-verify`; metadatos de Builder/Server en Read, sin permisos específicos de terminal. No tiene permisos sobre stacks existentes ni administra variables globales.
- **Los Repos ejecutan comandos privilegiados en el executor y la firma utiliza su Docker socket.** Estos permisos pertenecen al pipeline de código aprobado de `main`, no a agentes ni PRs. La ausencia de permisos sobre un Stack no convierte Write sobre un Repo en un límite de seguridad del host. Sólo código confiable debe recibir esa credencial.
- Clave + secreto API están en el environment GitHub como `AGENTS_RELEASE_KOMODO_KEY` / `AGENTS_RELEASE_KOMODO_SECRET`. Komodo resuelve las referencias de registry y Cosign allí mismo. No se pasan claves privadas como build args, flags, capas o logs. El script borra el envfile git-internal al terminar el job.
- App: `Dockerfile`, contexto raíz, imagen `registry.cubytest.space/cuby/agents`. Sandbox: `Dockerfile` dentro del contexto `sandbox/`, imagen `registry.cubytest.space/cuby/agents-sandbox`. Los builds usan Buildx/amd64, SHA completo explícito como tag, labels OCI revision/version y sin latest, tags de versión, auto-incremento, webhooks o auto-redeploy.
- Komodo 2.3.3 devuelve un hash corto en el Update. Además de comprobar ese prefijo, `pre_build` comprueba el SHA completo y el checkout limpio y emite exactamente un `AGENTS_RELEASE_SOURCE_SHA`. En sandbox esa comprobación corre desde la raíz, no desde el contexto `sandbox/`.
- Firma y verificación son **Repos dedicados**, no Procedures ni variables globales de inputs. Cada operación clona de nuevo el SHA aprobado. Inputs no secretos y referencias a secretos son configuración de esos recursos; no se leen valores privados desde el coordinador.

## Firma

La clave pública está en `release/cosign.pub`; SHA-256 fijado: `306102f7485320db8a37e90babb847b7f99e5910775d292d6a44801736475859`. Procede de la clave existente configurada en Komodo, no de una clave nueva. Cambiarla requiere revisión explícita.

Cosign `3.1.4` está fijado por checksum dentro de la imagen auxiliar inmutable y se comprueba su versión en la ejecución real. La política es **no publicar metadatos en Rekor público** (`transparencyLog=false`). Se conserva validación de clave, firma, anotaciones SHA/versión y digest; se omite deliberadamente la comprobación de transparencia pública. No hay promesa de verificación pública ni de identidad keyless.

Para este registry y esta versión se fijan modo legacy, `--new-bundle-format=false` y, al firmar, `--use-signing-config=false`. Este último es necesario: Cosign 3.1.4 rechaza `--tlog-upload=false` con su configuración nueva por defecto. El ensayo y la publicación comparten los mismos flags en `scripts/release/cosign.mjs`; no se asume compatibilidad de futuras versiones.

Se resuelve cada tag a digest, se comprueba amd64/labels, se firma y se verifica la referencia inmutable. El verificador independiente no recibe las referencias privadas. Emite exactamente un `AGENTS_RELEASE_MANIFEST`; el coordinador exige ambos digests firmados y la versión/SHA/plataforma esperados. Incluye lista y hash de los archivos de migración del commit, **no** estado de una base viva.

## Calidad y evidencia

Lefthook no reescribe ni hace staging: secretos del índice, formato, lint, tipos y tests. Gitleaks usa reglas estándar, versión/checksum fijados y salida redactada. Un hallazgo real necesita conciliación/rotación, no una allowlist improvisada.

`just ci` exige una base explícita `_test`, analiza historial de secretos, formato/lint/tipos/tests y construye web. CI arranca la imagen app real con dependencias sólo de producción y hace E2E con PostgreSQL temporal, sandbox/pi/Chrome reales, GPT simulado y usuarios sintéticos, incluido reinicio de API y sharing. Ninguna credencial de usuarios del producto participa. Los tests locales sin URL explícita omiten integración DB; eso no cuenta como CI completo.

El ensayo de infraestructura construye app y sandbox desde el SHA fijado, pero en namespaces `agents-release-probe*` con versión `setup`, y verifica firmas reales con la clave existente. No crea una release/tag de producto ni despliega. Su resultado y CI quedan enlazados en el hilo de Bubble; mocks solos no constituyen prueba de firma.

## Fallos, límites y recuperación

- Logs del Mac en `.release/` (gitignored, `0600`), más logs/records de GitHub y IDs de operaciones Komodo. Komodo entrega bloques de log, no necesariamente streaming continuo.
- Comandos del Mac: hasta 75 minutos; operación Komodo: 30; workflow: 60; contenedor JIT: 75. Una desconexión local no cancela automáticamente operaciones remotas.
- Al completar se retira el runner. Si no puede confirmarse que terminó un workflow despachado, el coordinador **no destruye un job que podría seguir publicando**: informa el nombre/URL para revisar y el límite de vida del contenedor. Un fallo de red no se reporta como limpieza confirmada.
- Un merge no se revierte si luego falla el build; una release no desaparece si falla un adjunto. No se borran tags, rebobinan migraciones ni reintentan publicaciones parciales a ciegas. Revisar GitHub y los IDs Komodo antes de recuperar un intento.
- Si faltan imágenes auxiliares locales, detenerse y reconstruirlas de manera deliberada; actualizar sus IDs versionados después de verificarlas. No hay instalación o reconstrucción implícita como fallback.
- No ejecutar `docker image prune`: los agentes aprobados fijan imágenes inmutables que podrían seguir siendo necesarias aunque se mueva un tag.

## Fuera de esta autorización

No se toca el PostgreSQL actual, cuentas/modelos/conversaciones/sesiones, stack Komodo `agents`, su `.env`, volúmenes, dominios ni routing de dev/prod. Los antiguos `just deploy image|sandbox|whatsapp` fallan sin operar. WhatsApp está excluido por un gate estático compartido API/web/prompt, preservando código y migración histórica; no se cambia el compose en uso.

Antes de añadir despliegue: elegir datos de origen, inventariar usuarios/sesiones, respaldar y ensayar restauración, acordar migraciones, revisar el compose real y rollback por digest. El nuevo sandbox debe estar disponible sin reasignar a agentes ya aprobados. `deploy/release.compose.yaml` sigue siendo un overlay de referencia, no un stack listo para aplicar. Dominios/redirecciones cambian después de aceptación y autorización aparte.
