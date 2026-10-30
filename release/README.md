# Release beta: configuración preparada, publicación y despliegue bloqueados

Este setup NO altera los entornos con usuarios. No despliega, migra, copia bases, cambia dominios ni crea `v0.0.1-beta`. Los dos bloqueos de `config.json` están en `false`; GitHub requiere además `AGENTS_RELEASE_ENABLED=true` y un disparo manual desde `just release` tras escribir `PUBLICAR`. Un push a `main` NO publica.

## Flujo único

```
just release plan                      sólo explica, sin operaciones remotas
just release                           falla antes de push mientras esté bloqueado

wip → PR → Required checks → confirmación PUBLICAR → merge protegido a main
                                                     ↓
                                      checks del SHA integrado
                                                     ↓
                              disparo manual → runner privado, sólo main
                                                     ↓
                         Komodo build app + sandbox, linux/amd64
                                                     ↓
                           firma + verificación por digest/key
                                                     ↓
                         tag/prerelease + release-manifest.json
                                                     ↓
                          FIN: no despliegue ni migración
```

- `main`: prereleases beta. `wip`: desarrollo, nunca publica. `stable`: rama ordinaria protegida e inactiva, necesaria para semantic-release; no se publican versiones estables en esta fase.
- `v2` se conserva congelada porque los entornos actuales pueden referenciarla. No se borra ni se cambia su configuración durante este setup. `wip` la sustituye para trabajo nuevo.
- Primer release: bootstrap explícito `v0.0.1-beta`. Después semantic-release calcula versiones a partir de los Conventional Commits integrados. CI valida los commits nuevos y el título de PR. Se usa merge normal (no squash/rebase) para conservar la ascendencia de `wip`, que es una rama continua; no se reescribe ni fuerza su historial al publicar. No se inventa un `1.0.0` inicial ni se permite salir de `0.x-beta` inadvertidamente.
- Lefthook no reescribe ni hace staging: sanitización del índice, formato, lint y types/tests. La primera normalización de formato se incluye en el setup. Gitleaks usa reglas estándar y salida redactada; no sustituye una rotación si aparece un secreto auténtico.
- `just ci` exige conexión explícita a una base `_test`, ejecuta historial de secretos, formato, lint, tipos/tests, tests de release y build web. El workflow añade arranque de la imagen app real con dependencias sólo de producción, sandbox real, Chrome, GPT simulado, usuarios sintéticos y reinicio de API. Ninguna credencial real del producto participa.

## Requisitos de activación, todavía no concedidos por este setup

1. Autorizar publicar el baseline en una PR que cambie `publicationEnabled`; mantener `deploymentEnabled=false` hasta acordar el corte. Un cambio de variable de entorno no puede saltar el bloqueo versionado.
2. Provisionar runner Linux x64 exclusivo con etiqueta `agents-release`, Node/Bun fijados, acceso privado a Komodo y checkout independiente. No usar los checkouts que sirven a los usuarios. No ejecutar PRs ni código externo en este runner. Los checks de PR usan runners efímeros de GitHub.
3. El entorno GitHub `agents-release` admite únicamente `main`. El plan actual del repo privado NO permite required reviewers (API devolvió 422); no se finge esa protección. La aprobación es el disparo manual autorizado de `just release`, no un job automático de push. Clave + secreto de API de Komodo de mínimo privilegio se guardan allí como `AGENTS_RELEASE_KOMODO_KEY` y `AGENTS_RELEASE_KOMODO_SECRET`. Cosign privado sigue sólo en Komodo; nunca en GitHub, Mac, build args, imágenes o logs.
4. Crear recursos NUEVOS `agents-release-app`, `agents-release-sandbox`, `agents-release-sign`, `agents-release-verify`. No reutilizar un build que despliegue automáticamente el stack actual. Desactivar webhooks, auto-incremento, `latest`, tags flotantes mayor/menor y cualquier auto-redeploy. El builder debe ser el Server de reko-3 con Buildx, plataforma `linux/amd64`, repo privado y credenciales del registry ya autorizadas.
5. Build app usa `Dockerfile`, sandbox usa `sandbox/Dockerfile`, contexto `sandbox/`. Imágenes: `registry.cubytest.space/cuby/agents` y `agents-sandbox`. El coordinador fija SHA completo, desactiva incrementos y tags flotantes, y agrega labels OCI de SHA/versión. Los tags concretos emitidos por la versión instalada de Komodo deben verificarse antes de activar; no inferirlos de un SHA abreviado. Los procedimientos reciben esos tags exactos en `AGENTS_RELEASE_APP_TAG` y `AGENTS_RELEASE_SANDBOX_TAG`.
6. Crear variables NO secretas `AGENTS_RELEASE_SHA` y `AGENTS_RELEASE_VERSION`; son inputs nuevos y exclusivos del release. La concurrencia global del workflow serializa todo build/firma/publicación. Ningún webhook/usuario debe disparar estas mismas procedures fuera del coordinador mientras corre un release.
7. Los procedimientos de firma/verificación ejecutan `node scripts/release/sign-images.mjs sign|verify` desde el mismo SHA en reko-3 con `DOCKER_CONTEXT` explícito. Inyectar allí los dos inputs anteriores, tags resueltos del build y, sólo en firma, la referencia `COSIGN_KEY_REF` y el material ya existente en Komodo. Se admite `env://NOMBRE_EXISTENTE`, archivo privado del executor o KMS; no pegar material privado en el comando. El procedimiento de verificación no necesita clave privada. No crear/copiar otra clave por comodidad.
8. Obtener únicamente la clave PÚBLICA, fijar su SHA-256 en `cosignPublicKeySha256` y disponer de `COSIGN_PUBLIC_KEY_FILE` en el executor. Usar Cosign `3.1.4` (comprobar compatibilidad con el registry actual antes de habilitar). Autorizar `transparencyLog=true|false`: publicar en Rekor expone metadatos; si se elige `false`, la verificación mantiene clave/claims/digest pero omite deliberadamente Rekor. No se decide por defecto.
9. Verificador exige una sola plataforma runtime amd64 (permite atestaciones), labels del SHA/versión, firma con la clave fijada y digest coincidente. Imprime exactamente un marcador `AGENTS_RELEASE_MANIFEST {...}`. El manifiesto incluye la lista y SHA-256 del conjunto de migraciones que trae el commit, no el estado de una base viva; no se conecta a PostgreSQL para calcularlo. El coordinador rechaza markers ausentes, repetidos, versiones/SHAs/migraciones distintos o refs mutables. Debe probarse una firma auténtica con los recursos reales antes de activar la publicación; las pruebas con mocks no la sustituyen.
10. Habilitar `AGENTS_RELEASE_ENABLED=true` sólo después del ensayo y autorización. Primer `just release` abre/reutiliza PR, espera checks, pide PUBLICAR, integra dispara el workflow manual con ese SHA y sigue sus logs. Un fallo detiene los pasos siguientes y deja visible el estado parcial.

## Qué NO hace el comando

- No instala herramientas del sistema, usa sudo, hace commits ni modifica archivos sin commit.
- No conecta al PostgreSQL actual ni a cuentas/modelos de usuarios, no modifica la pila Komodo `agents`, su `.env` ni sus secretos.
- No cambia `agents-dev.cubytest.space`, `agents.cubytest.space`, Traefik, datos, volúmenes ni imágenes ya fijadas por agentes.
- Los antiguos `just deploy image|sandbox|whatsapp` quedan retirados: fallan sin construir/publicar, para no saltarse el flujo único.
- No configura un auto-deploy escondido. `deploymentEnabled` existe como segunda barrera para la fase futura, pero esta versión del coordinador no incluye una operación DeployStack.
- WhatsApp queda fuera del producto beta por un feature gate estático compartido API/web/prompt. Rutas devuelven 404 y operaciones internas rechazan el canal aun con variables antiguas. Se conserva el código y `009_whatsapp.sql`; el overlay futuro no incluye puente/secretos WhatsApp. No se modifica el compose de los entornos existentes.

## Fallos y recuperación

- Logs locales en `.release/` (gitignored, `0600`). Workflow ofrece estado, logs y manifiesto, sin imprimir credenciales del coordinador. Komodo puede entregar logs por bloques, no necesariamente streaming continuo.
- Las esperas/comandos del coordinador tienen tope de 75 minutos; Komodo, 30 minutos por operación; jobs de CI también tienen timeout. Timeout local o interrupción de la consola NO cancelan por sí solos un build/workflow remoto. Revisar ID de operación antes de reintentar. Nunca duplicar a ciegas.
- Un merge ya hecho no se revierte si falla el build. Una release ya publicada no desaparece si falla el adjunto. No se borran tags ni se rebobinan migraciones automáticamente.
- Si falla antes de publicar: revisar los IDs de Komodo y el SHA, resolver la causa, y reejecutar el workflow únicamente después de comprobar ausencia de tag/release. Si existe un tag o release parcial, completar/conciliar explícitamente, sin crear otro baseline.
- Durante el setup se conservan todos los artefactos actuales. No ejecutar `docker image prune`: los agentes aprobados fijan IDs inmutables de sandbox que podrían ser necesarios aunque un tag se haya movido.

## Fase posterior: corte y datos

Antes de añadir despliegue a `just release`: decidir qué entorno aporta datos, inventariar enlaces/usuarios/sesiones, respaldar PostgreSQL y memoria de agentes, ensayar restauración, confirmar la política de migraciones, revisión del compose real y rollback por digest. El sandbox verificado debe estar disponible localmente en reko-3 antes de cambiar el default, sin reasignar automáticamente a agentes ya aprobados. `deploy/release.compose.yaml` es sólo un overlay de referencia, no un stack listo para aplicar. El dominio y la redirección se cambian después de aceptación, no como sustituto de una migración.
