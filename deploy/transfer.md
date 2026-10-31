# Traslado puntual de usuarios/agentes a beta1

Angel retomó el traslado y autorizó expresamente la **copia local previa en reko-3**, dejando S3 y la automatización de respaldos pendientes. Autorización acotada en `transfer-authorization.json`; no es aprobación de dueños ni permiso para borrar el origen. El ejecutor se implementa en `scripts/deploy/transfer.py` y `transfer_remote.py`. No reconstruye/publica imágenes ni usa un ensayo online antiguo como snapshot final.

## Ejecución

```sh
just transfer audit             # preflight remoto; sin interrupción ni dump/tar
just transfer apply             # exige checkout limpio y los 3 checks del SHA exacto en PR #4
just transfer recover <run>     # sólo recuperación explícita ANTES de intentar arrancar el destino
```

`just cutover plan|rehearse` conserva su papel de modelo local histórico; su `apply` no es este ejecutor. `just deploy` continúa siendo preparación. No invocar `just release` para trasladar datos.

Las operaciones remotas requieren `cuby-agents-prod` visible. El job vive además en tmux de reko-3, `agents-transfer-<run>`, para sobrevivir a una desconexión del coordinador. Estado durable privado `~/.local/state/agents-transfer/<run>/status.json`, escrito/renombrado con fsync. Un resultado incierto exige leer ese estado, **no repetir apply**. No hay reintento ni rollback automático de operaciones de escritura.

La credencial de `1Password → Cuby → Komodo Admin` se lee por sus dos campos de login y pasa por memoria/SSH/stdin y un FIFO 0600 dentro de directorio 0700; no se escribe a disco ni a tmux/argv. Login JWT temporal, sin crear API keys. Las respuestas crudas de Komodo, secretos, dumps, archivos y logs de app no salen de reko-3. El Mac recibe únicamente estado/conteos/hashes permitidos.

## Secuencia y límites

1. Verificar daemon reko-3, imágenes inmutables precargadas, stack gestionado/sin auto-update, alcance 7 personas/9 agentes ajenos a Test y producción Angelk sin agentes. Rechazar destinos existentes, trabajo pendiente y cambios de infraestructura.
2. Comparar semánticamente Compose: PostgreSQL/CLIProxyAPI, redes, routing y **servicio de backup completo** iguales a los actuales. El Compose efectivo se guarda como JSON válido para Compose y su hash queda en el journal. Se conserva el backup actual en vez del cambio propuesto en `beta.compose.yaml`.
3. Verificar metadatos de escritores externos/espacio libre: helper efímero sin red/socket Docker, todos los orígenes montados RO. El helper operativo usa namespace PID del host, SYS_PTRACE/DAC de lectura y AppArmor sin perfil para inspeccionar FDs y mmap compartidos escribibles por inode; no lee contenido de archivos de las personas ni memoria de procesos. Esto es autoridad privilegiada del operador, **no** capacidad nueva de los agentes ni aislamiento del host. Datos inaccesibles abortan, no se interpretan como cero.
4. Poner ambos hosts en mantenimiento HTTP 503 y comprobar el marcador. Detener bridge, comprobar DBOS/corridas/mensajes/entregas/leases de diseño y sandboxes; detener web/ambos servidores por los IDs observados. Esto cierra conexiones antiguas; un router solo no las cerraría. Repetir drenado y comprobar FDs/mmap de perfiles/datos. No cancelar ni borrar trabajo para fabricar cero.
5. Sólo con escritores detenidos: generar dump/tar/config privados; reutilizar transformación, recifrado, restauración aislada, comparación de 13 tar/55 tablas, probes y firmas. Volver a comparar cada archivo tar con su origen. CLIProxyAPI sigue funcionando: su copia se compara, pero no se afirma congelado global del proveedor/proxy ni recuperación de un desastre de host.
6. Crear `agents_beta1`, `/srv/agents/releases/beta1/data` y nueve volúmenes `agents-prod-beta1-agent-10…18`. Restaurar perfiles con metadata, filtrar archivos referenciados y comparar todas las filas del destino con el dump preparado **antes del primer arranque**. Test sólo se excluye del destino; conservar retirado16, historia/revisiones y Angelk separado. Pausar agendas únicamente en la DB nueva.
7. Actualizar sólo contenido Compose del stack y archivo materializado, conservando `.env`; arrancar sólo `server --no-deps --no-build --pull never`. Registrar `bootAttempted=true` durable **antes** del comando: desde ahí cualquier error exige reconciliación, incluso bajo mantenimiento.
8. Verificar imagen/DB/llave/PIN/proxy efectivos, health SHA, decrypt de todos los campos conservados, visibilidad de las 7 personas con sesiones sintéticas eliminadas después, Test ausente, estado independiente, retirado16, web200/WhatsApp404 y egress real. No iniciar navegador/GPT ni afirmar login real o continuidad externa probada.
9. Comprobar IDs/fechas de PostgreSQL/CLIProxyAPI/backup intactos y dev detenido; restaurar estados de agendas sin backfill en producción, retirar mantenimiento y comprobar health público. Desarrollo queda detenido, con bases/config/datos/volúmenes intactos, evitando dos schedulers/escritores.

## Respaldos y acceso

- La copia local final y el dump preparado quedan privados en `~/.local/state/agents-migration/<snapshot-run>/`. Se retienen también al fallar; no borrar ni exportar. No equivalen a backup offsite.
- **El backup diario existente no se modifica/reinicia y seguirá sobre la DB anterior `agents`. La DB nueva beta1 NO queda bajo ese calendario.** S3 y automatización para beta1 continúan pendientes por instrucción de Angel; sólo existe la copia local inicial de este traslado. No inicializar/subir/verificar S3 implícitamente.
- Conservar la llave/PIN/proxy de producción y recifrar al destino. La custodia de la master key en 1Password ya se verificó por separado; no reemplaza copia de datos.
- Angelk conserva accesos prod remapeados. Los 6 usuarios trasladados necesitan login nuevo con el PIN prod o invitación nueva para **sus mismas identidades**; no promover sesiones/admin de dev. No escribir tokens/invitaciones en logs/Bubble. Los enlaces firmados/URLs de hooks dev requieren atender el cambio de dominio; no se alteran payloads históricos.
- Recuperación prearranque: comando explícito, confirmar IDs de origen y ausencia de intento de boot. Si se intentó cambiar el stack, comparar/restaurar sólo el cambio propio conocido; cambios ajenos abortan. Después del intento de boot, `recover` rechaza: inspeccionar DBOS, nuevas escrituras, tareas/efectos y reconciliar antes de cualquier retorno al origen. Los pins históricos ausentes siguen limitando rollback ejecutable.

El presupuesto previo de 15 minutos no es una duración medida ni garantía de cero pérdida. El registro de ejecución real debe distinguirse de los ensayos y de las diez regresiones locales sin infraestructura.
