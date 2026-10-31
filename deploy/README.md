# Preparación del traslado a v0.0.1-beta

**Preparación, no despliegue.** Desarrollo contiene 6 personas reales y 9 agentes ajenos a Test. Producción contiene Angelk, otra identidad, sin agentes. El encargo es desarrollo → producción, excluyendo Test y sus 9 agentes sólo del destino, conservando el origen. No fusionar Angel y Angelk por tener ID 2 en bases distintas.

- [Plan de corte, accesos, interrupción, abortar y recuperar](cutover.md).
- [Candidato Compose completo para esta beta](beta.compose.yaml): no aplicar durante preparación. El overlay antiguo `release.compose.yaml` no es un stack independiente.
- [Evidencia de ensayos](preparation-proof.json).

```text
DEV/PROD (lectura) ── dumps ──► Postgres temporal sin red, dos bases separadas
                                  │ excluir Test y referencias DBOS/huérfanas
                                  │ recifrar con llave de producción y separar Angelk
                                  │ nuevas revisiones beta sólo para activos
                                  │ refs de volúmenes nuevas; política de sesiones
                                  └ dump preparado ──► tercera base recuperada
                                                       └ app beta real, sin red/socket
                                                         cron pausado sólo en esa copia

Datos/volúmenes (readonly) ── tar ──► restaurar y comparar ACL/xattrs
                                     └ datos referenciados a otra copia; verificar hashes
```

## Comandos

En `~/dev/work/agents-release-setup`:

```sh
just deploy plan
just deploy inspect
just deploy rehearse
```

- `plan` no hace operaciones remotas. `inspect` consulta metadatos, busca pins históricos en Zot y verifica las firmas publicadas.
- Los modos remotos abren ventanas propias en `cuby-agents-prod`; ver con `tmux attach -t cuby-agents-prod`. SSH/contexto Docker explícitos y daemon ID verificado, sólo reko-3. No reinician servicios existentes.
- Helpers/base/app de ensayo usan referencias fijas, `--pull=never`, límites y etiquetas de pertenencia. Las transformaciones/restauraciones y el arranque de app tienen `--network none`, sin socket Docker. La app sólo accede a una tercera copia, sin trabajo pendiente y con cron pausado antes de arrancarla.
- Hay dos probes de red explícitos: GET `/v1/models` desde el namespace del backend prod, con claves descifradas sólo en reko-3; y checks TCP desde la red sandbox prod, sin secretos ni perfiles. No hay inferencia ni mutaciones de configuración. Los resultados no incluyen claves, URLs privadas de proxies ni catálogos completos.
- Manifiesto: asset publicado de GitHub, SHA-256 `52c9dbd1124134774806312a53e3aff81766af6da440654db6d56d2fae383b3c`. Se usa `.release/verify-first-release/release-manifest.json` o autenticación habitual `gh` para descargarlo; se valida su hash antes de usarlo.
- No existe `apply`; `deploymentEnabled=false`. No cambia bases vivas, pins, rutas, llaves ni stacks. No usar `just release` para trasladar datos.

## Lo que verifica el ensayo

1. Dumps de ambas bases con origen read-only y timeout. Restauración en Postgres aislado/tmpfs, DB distintas, sin arrancar workers contra bases compartidas.
2. Exclusión de Test/agentes 1–9 sólo en la copia; detección de dependencias cruzadas que harían perder registros reales. Conservación de corridas/conversaciones y agente retirado 16.
3. Apertura y recifrado de 19 campos usando las llaves privadas de dev/prod, sin rotación. Incorpora Angelk con ID nuevo y conserva sus accesos/timestamps con precisión de Postgres. Las sesiones/invitaciones dev no pasan al destino; allí se entra por nueva invitación al mismo usuario, sin heredar admin.
4. Actualiza `state_ref` a `agents-prod-beta1-agent-<id>` para los 9 agentes, incluidos los retirados; nunca crea esos volúmenes finales durante preparación. Aborta si los destinos reservados ya existen. El default de sandbox de la copia también apunta a la beta.
5. Clasifica historia DBOS terminal por referencias vigentes de corridas/entregas/agentes. Excluye sólo de la copia Test, historia terminal sin referencia conservada y su cola. Aborta ante función/contexto desconocido, dependencia cruzada o workflow no terminal. Conserva agendas reales byte-a-byte, timezone y política sin backfill. No ejecuta workflows de negocio.
6. Restaura el **dump transformado** en una tercera DB y compara fingerprints de todas las filas de las 55 tablas antes del arranque. Esto prueba recuperación de datos; no simula pérdida completa de host ni un corte coordinado.
7. Restaura/compara los 13 tar de 9 volúmenes reales y data/cliproxy de ambos entornos, con ACL/xattrs. Copia a otra raíz temporal sólo archivos referenciados y snapshots de corridas conservadas; rechaza rutas ambiguas, symlinks y archivos no regulares, compara hashes y conserva metadata. Los archivos brutos originales/respaldos no se borran.
8. Arranca la **app publicada** contra la tercera DB, sin red/socket Docker. Comprueba web/health SHA/version, guardas HTTP/WhatsApp 404 y visibilidad de las 7 personas con sesiones sintéticas temporales, sin admin implícito. No prueba la cookie del navegador real ni inicia Chrome/GPT. Sólo esa copia se pausa para impedir cron durante aceptación.
9. Verifica firmas Cosign del OCI local mediante ECDSA-SHA256 y la llave pública fijada (`306102f7…875859`), digest/repositorio/SHA/versión firmados, hashes de manifiesto/config/payload y plataforma/etiquetas. Sin credenciales de registro, firma nueva, clave privada ni Rekor. Es verificación criptográfica independiente con Node; no una nueva ejecución del CLI `cosign verify`, prueba cold-cache, escaneo de vulnerabilidades o QA funcional de imágenes históricas.
10. Desde el namespace prod autentica los 5 proxies con GET de modelos y comprueba disponibilidad de los modelos de agentes activos. El sandbox debe alcanzar internet y su backend, no LAN/router/tailnet/gateway SSH/dockerd/metadata cloud.
11. Limpia sólo contenedores/volúmenes temporales de su ejecución con etiquetas verificadas. Conserva backups privados y reporta fallos. La comparación de configuración viva excluye contadores transitorios de actividad, registrados aparte: el origen continúa trabajando, esto no demuestra drenado.

Los respaldos/llaves/configuración/logs de app y el manifiesto privado de rutas quedan **sólo en reko-3**, `~/.local/state/agents-migration/<ejecución>/`, directorios 0700 y archivos privados. No subir, servir ni copiar al Mac/Bubble. Los informes ignorados `.release/deploy-prepare/` contienen metadatos/checksums, no mensajes ni secretos. `operatorSourceSha256` cubre programa remoto, workers de transformación/DBOS/copia/firmas/arranque/red y script egress ejecutados.

## Autorización de imagen, no de corte

Angel: «si, usa los containers que ya estan para la release». `image-transition.json` conserva la decisión/hash: reutilizar app y sandbox **publicados**, sin build, firma nueva ni otra release.

- App: `registry.cubytest.space/cuby/agents-app@sha256:8a8d92f6ad22e024e3defba54261e903e60b24e43a18f5efd0d1e13a534916a8`.
- Sandbox: `registry.cubytest.space/cuby/agents-sandbox@sha256:04771072a9d1064e52c034b1f59a1db7c46f695c760568cc9af76d20d5bebd40`.

Los 9 harness pasan probes ligados al mismo hash canónico/ref/config ID. Se añaden 8 revisiones nuevas para activos, sólo cambiando imagen y número de revisión de su contrato; no reescribir revisiones antiguas ni definiciones de corridas. Rol/modelo/herramientas/propiedad/permisos se conservan; el cambio separado de `state_ref` es únicamente mapeo de almacenamiento de la copia. Retirado 16 no se reactiva ni se repinea. Se conserva la discrepancia previa de imagen histórica/efectiva de 10–13 en `sourceImageDifferences`, sin “reparar” el pasado. No se fabrican aprobaciones de dueños ni se cambia `agent_designs.harness_validation`. El JSON de decisión no es un servicio de autorización ni permiso de apply.

## Evidencia y límites

Ensayo completo `20261031T155740Z-03c3066b`: 7 personas incluyendo Angelk, 9 agentes (8 activos/1 retirado), 255 corridas y 13 conversaciones; 19 campos recifrados, 13 archivos restaurados/comparados, 97 archivos de app copiados con hash y 120 huérfanos/excluidos no promovidos. Conserva 688 workflows terminales y 1 agenda; excluye 213 workflows sin referencia conservada/Test y la cola de Test sólo en la copia. Recuperación de 55 tablas idéntica; arranque/accesos de 7 personas, 5 proxies y 8 checks egress satisfactorios. Fuentes vivas sin cambios de configuración, cero recursos temporales restantes. Los conteos son del snapshot, no congelan la actividad de dev.

Antes de ese éxito se abortaron/limpiaron dos intentos: escritura del manifiesto privado sin permiso suficiente del helper y un probe contra una URL WhatsApp incorrecta. Se corrigieron los permisos **del helper aislado**, no los archivos vivos, y el probe (`/api/admin/whatsapp`), sin alterar el producto publicado. Los fallos anteriores de comparación de imagen histórica/efectiva también se conservan en la evidencia de la iteración previa.

Auditoría adicional: DBOS sin payloads/checkpoints huérfanos ni filas legacy en `event_dispatch_kv`; candidato comparado semánticamente con el Compose privado vivo, PostgreSQL/CLIProxyAPI/redes/labels de routing idénticos. Contraseña de DB del archivo coincide con la efectiva y autentica una conexión read-only real. Master key/PIN/proxy key también coinciden; nada se rotó. Estas consultas fueron visibles y privadas en reko-3.

**Todavía no es un corte:** backups online en el mismo host, no snapshot coordinado ni offsite. Falta confirmar escrow fuera del host, aceptar la política de accesos/enlaces, concretar/revisar la operación ejecutable contra el estado final, aprobar horario/corte, tomar backup final drenado y hacer aceptación real de navegador/tarea. Los pins históricos perdidos siguen limitando rollback: recuperar datos con la beta no recupera imágenes ausentes. El [plan de corte](cutover.md) separa estos límites del resultado del ensayo.

Seguimiento: Bubble `agents`, hilo #17; PR #4. No se ha fusionado/aplicado como despliegue ni publicado otra release.
