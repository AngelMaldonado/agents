# Respaldo cifrado en S3 — cableado opt-in

Estado inicial: **deshabilitado**. No hay bucket ni credenciales configurados por el código, no se han enviado datos reales y no se crea un calendario nuevo. Funciona con los backups ya existentes en reko-3, sin reconstruir/publicar la app beta ni cambiar servicios/DB/llaves/routing. El backup local actual permanece como está.

```text
reko-3: backup existente (readonly)
  dump diario      ──┐
  o snapshot completo├── restic: cifrado/autenticación cliente ── HTTPS ── S3/prefijo dedicado
                     │                                              │
                     └─ original intacto ◄── comprobar manifest ◄── restauración temporal
                                              + hashes                 privada en reko-3
```

Restic cifra datos y metadata antes de subirlos. Imagen oficial **restic 0.19.1 linux/amd64** fijada por digest: `restic/restic@sha256:08916bcda4a4435f9d9828ebb4e91bb7ada3d2c8a53699788930e0ae1bd4fa67`. No se instala nada en el sistema del host, no hay imagen nueva de Agents, y los helpers no montan socket Docker. La clave de cifrado del repositorio deriva de una contraseña **distinta** de `AGENTS_MASTER_KEY`; conservar ambas en 1Password.

## Configuración posterior

Copiar las variables de [`backup-s3.env.example`](backup-s3.env.example) al **Environment del stack `agents` de Komodo**. No poner credenciales en `.env.production` del Mac, git, argumentos, documentos o chat. Se leen exclusivamente del archivo privado que Komodo materializa en `/etc/komodo/stacks/agents/.env` en reko-3. El parser no ejecuta shell ni expande referencias `${...}`: usar valores literales, con comillas simples/dobles exteriores si hace falta.

| Variable                             | Valor requerido                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `AGENTS_BACKUP_S3_ENABLED`           | `false` por defecto; sólo `true` activa operaciones S3.                                                        |
| `AGENTS_BACKUP_S3_REPOSITORY`        | `s3:https://<endpoint>/<bucket>/<prefijo-dedicado>`; sin usuario/password en URL, query, HTTP ni rutas `..`.   |
| `AGENTS_BACKUP_S3_REGION`            | Región del proveedor; default `us-east-1`.                                                                     |
| `AGENTS_BACKUP_S3_ACCESS_KEY_ID`     | Acceso al bucket/prefijo dedicado.                                                                             |
| `AGENTS_BACKUP_S3_SECRET_ACCESS_KEY` | Secreto S3 correspondiente.                                                                                    |
| `AGENTS_BACKUP_S3_SESSION_TOKEN`     | Sólo si se usan credenciales temporales.                                                                       |
| `AGENTS_BACKUP_S3_PASSWORD`          | Contraseña aleatoria independiente, mínimo 20 caracteres. Guardarla en 1Password antes de inicializar el repo. |

Ejemplos de **forma**, no destinos ya provisionados:

```text
AWS:            s3:https://s3.amazonaws.com/mi-bucket/agents/prod
Compatible S3:  s3:https://s3.proveedor.example/mi-bucket/agents/prod
```

El bucket debe existir; el cableado no lo crea, no modifica sus ACL/políticas y no concede permisos públicos. Usar bucket privado, TLS y credenciales dedicadas al prefijo. IAM necesita `s3:ListBucket` acotado al prefijo, `s3:GetBucketLocation` y `s3:GetObject`/`PutObject`/`DeleteObject` sobre los objetos del repo; `DeleteObject` es necesario también para locks temporales de restic. El runner no ofrece `forget`, `prune` ni borrado de snapshots, pero estas credenciales **no constituyen una garantía append-only**. Versionado/Object Lock requieren diseño del proveedor compatible con los locks de restic; no se configuran automáticamente.

No aplicar una regla de expiración por antigüedad a objetos internos del repositorio: los packs se comparten entre snapshots y se corrompería el backup. Sin retención/pruning remotos automáticos en esta versión. El borrado/rotación de dumps locales que ya hace el servicio existente no cambia.

**Poner secretos no dispara una subida.** Primero comprobar que Komodo los haya materializado en el archivo privado y luego ejecutar los comandos siguientes. No forzar un redeploy/reinicio de server/DB para actualizar el transporte de backup; el runner está separado de esos servicios. Las variables no se pasan a server ni a sandboxes.

## Operación

Desde `~/dev/work/agents-release-setup`:

```sh
just backup                         # plan local, sin SSH ni S3
just backup check                   # configuración + estructura del repositorio
just backup init                    # una sola vez, si se quiere crear un repositorio nuevo
just backup push 20261031T155740Z-03c3066b
just backup push daily
just backup verify <snapshot-id-completo-de-64-hex>
```

- Todos los modos remotos se ejecutan en ventanas únicas de `cuby-agents-prod`; ver con `tmux attach -t cuby-agents-prod`. Verifican SSH, contexto Docker e identidad de reko-3 antes de acceder al archivo privado. `plan` nunca consulta la infraestructura.
- Sin flag de activación, `check` informa `disabled-no-s3-requests`. `init/push/verify` no hacen requests S3 ni pasan como backup exitoso. Con `true` y campos incompletos/ambiguos, abortan antes de contactar S3. Sólo el helper de lectura de configuración sin red se ejecuta en ese caso.
- La imagen de restic se precargó para el ensayo sintético en reko-3. En un host recuperado debe descargarse ese mismo digest con Docker/contexto explícitos antes de operar. Se usa `--pull=never` en ejecución; no se reconstruye ni se cambia silenciosamente de versión.
- `init` es explícito y escribe un repositorio nuevo. Un fallo de autenticación, password, red o lock **no** dispara init/unlock/prune. Cambiar la contraseña en Komodo no recifra un repositorio existente: generaría error; la rotación requiere una operación deliberada aparte.
- `check` valida estructura del repo, **no lee todos los datos ni prueba restauración**. Restic puede crear/quitar locks temporales; no crea un snapshot.
- `push <run>` acepta sólo el ID exacto de un respaldo **terminado con éxito** bajo `~/.local/state/agents-migration/`. Revalida estado, hashes de 13 tar y 3 dumps, archivos privados de configuración/manifiesto y ausencia de symlinks/archivos especiales/hardlinks en el árbol externo. Copia el directorio completo cifrado, incluidos configuración, llaves, logs y perfiles archivados: tratar el acceso a repo+password como acceso a todos esos datos. No toma un snapshot nuevo ni detiene escritores.
- Ese respaldo de ensayo incluye datos originales de Test dentro de los dumps brutos para recuperación; **no** es la base filtrada destinada al producto. No es necesario ni correcto borrar evidencia/backups brutos para excluir Test de producción.
- `push daily` sólo envía los `.dump` existentes en `/srv/agents/backups`, con nombres de backup conocidos y excluyendo `.tmp`. **No** incluye perfiles, archivos, configuración ni llaves. No lo anunciar como recuperación completa de Agents. Si hay archivos inesperados o restic detecta lecturas incompletas, aborta.
- `push` captura el ID completo del snapshot y luego descarga/restaura ese snapshot completo con `--verify` a un directorio privado **nuevo** en reko-3. Para snapshots de migración, vuelve a comprobar el manifiesto y hashes restaurados antes de declarar éxito. Esto consume transferencia y espacio temporal; comprueba espacio del snapshot + 1 GiB. Nunca restaura encima de DB/datos/perfiles en uso. `verify <id>` repite esa comprobación, sin aceptar `latest`/IDs abreviados.
- Limpia sólo los helpers etiquetados y la restauración temporal de la ejecución; **no borra origen ni snapshot S3**, tampoco cuando la verificación falla. Si hubo subida pero falló recuperación, conserva/reportará `snapshot` y `snapshotCreated:true` junto a `ok:false`; resolver antes de reintentar. Un error de backup puede haber dejado objetos o un snapshot parcial: `remoteChangesMayExist:true` no es rollback.
- Logs Docker deshabilitados para estos helpers; stdout/stderr privados de restic/proveedor nunca se reenvían a Mac. Credenciales sólo en memoria/environment del helper, no en argv/envfiles nuevos. Quien controla el daemon/root puede inspeccionar esos procesos: es autoridad operativa privilegiada, no aislamiento frente al host.
- Informes sólo de metadatos en `~/.local/state/agents-backup-reports/<ejecución>.json` de reko-3, directorio 0700/archivos 0600. Sirven para reconciliar estado parcial tras desconexión del Mac. Un proceso remoto puede terminar o continuar tras desconectarse: no asumir éxito ni reintentar sin revisar. Si la limpieza falla, el informe no es exitoso.

## Alcance de las pruebas y del corte

El ensayo del cableado usa sólo un archivo ficticio y repositorio local temporal, sin red/S3 ni credenciales reales: init → backup → check leyendo datos → restore con verificación → comparación del archivo. Las regresiones locales cubren default-off, configuración, destinos, secretos fuera de argv, backup parcial y fallo de restauración. **No se ha probado el endpoint S3 real**; hay que hacerlo tras configurar secretos, incluido permisos, password, cuota/costos y recuperación con el snapshot completo.

Los backups de `agents-migration` actuales son **online/on-host**; subirlos cifrados no los convierte en un snapshot coordinado DB+filesystem. El respaldo final del corte se tomará con escritores detenidos y deberá conectarse/revisarse explícitamente con este transporte; no se finge que este código prepara o aplica el corte. La recuperación tras pérdida completa de reko-3 tampoco queda probada por restaurar en ese mismo host.

Para recuperar desde otro host se necesitan endpoint/prefijo, credenciales S3, password del repo, versión de restic y la copia de `AGENTS_MASTER_KEY` de 1Password. `restic restore <id> --target <directorio-vacío> --verify` recupera **archivos**, no arranca servicios ni restaura PostgreSQL por sí solo. Seleccionar la copia correcta de cada entorno, recifrado/identidades y restauración DB/volúmenes siguen el [plan de corte](cutover.md). Nunca volcar secretos ni sobrescribir un entorno para “probar” la recuperación.
