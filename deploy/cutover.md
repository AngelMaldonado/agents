# Corte propuesto: desarrollo → producción, primera beta

**Plan original de preparación, no recibo de ejecución.** Posteriormente Angel retomó el traslado y autorizó copia local previa, dejando S3/automatización pendientes: ver [ejecutor puntual `just transfer`, guardas y política vigente](transfer.md). Los bloqueos y pendientes descritos abajo corresponden al modelo original. `just deploy` sólo prepara. No repetir `just release`: la beta publicada es el artefacto que se usará. El candidato completo es [`beta.compose.yaml`](beta.compose.yaml); no aplicar el overlay antiguo por separado.

## Resultado y límites

```text
Origen dev (se conserva)                 Destino nuevo, aislado del original prod
  DB agents + datos + 9 volúmenes reales   DB agents_beta1 (en PostgreSQL existente)
         │                                  + Angelk separado y accesos prod preservados
         └─ copia/filtrado/recifrado ───────► - Test y agentes 1–9
                                             + agentes 10–18, incluido retirado 16
                                             + 8 revisiones beta, sin alterar revisiones previas
                                             + /srv/agents/releases/beta1/data
                                             + agents-prod-beta1-agent-<id>

Original prod: DB agents y /srv/agents/data quedan intactos para recuperación.
```

- Producción conserva su **master key, PIN y proxy key efectivos**; el recifrado se hace en reko-3. No se rota/promueve la llave de desarrollo. El ensayo compara el archivo privado con la configuración efectiva del servidor de producción.
- Las nuevas refs de volúmenes son distintas de desarrollo. Se copian archivos/ACL/xattrs; nunca montar los mismos perfiles con escritura en ambas instancias. El agente 16 continúa retirado y conserva su imagen histórica.
- Se conservan corridas, conversaciones, revisiones y permisos reales. DBOS mantiene versión durable `v2`, distinta del SHA/versionado de la release. Sólo se conserva historia terminal atribuible a los registros retenidos; lo de Test y workflows terminales sin referencia pública vigente no pasa a la copia. La historia bruta permanece en origen y dumps privados. Ante workflow no terminal, función/contexto desconocido o dependencia cruzada, abortar: no improvisar replay ni borrar por parecido de IDs.
- Se conserva la definición de la agenda de 17, sin backfill. Durante validación del destino se pausa **sólo la copia**; se reactiva una vez y sólo después de desactivar el origen. Así se evita duplicar tareas programadas.
- Datos de app: copiar sólo archivos referenciados por filas conservadas y snapshots de sus corridas. No copiar archivos de Test ni huérfanos a la raíz nueva. No borrar los originales ni los archivos brutos de respaldo.
- CLIProxyAPI mantiene su imagen/configuración de producción. El candidato no requiere servicio, credencial ni red de WhatsApp; tampoco elimina su código/migraciones/historia.

## Accesos y canales: efectos visibles

- URL final: `https://agents.cubytest.space`. Los 6 usuarios trasladados necesitan **nueva invitación al mismo usuario**, no otra cuenta: las cookies son host-only y las de `agents-dev.cubytest.space` no se transfieren. No conservar privilegios admin de desarrollo por trasplantar sesiones.
- Angelk sigue siendo otra identidad, con sesiones/invitaciones originales de producción remapeadas a su nuevo ID; no se equipara con Angel por compartir el ID 2 entre bases. El ensayo HTTP usa sesiones sintéticas sólo en una copia destruida: no prueba la cookie real del navegador de Angelk.
- Los tokens/secretos de hooks se conservan; los emisores deben usar el dominio de producción. No reescribir payloads o mensajes históricos con URLs. No redirigir automáticamente requests con autenticación del dominio dev al prod.
- Los enlaces firmados antiguos de desarrollo derivan de su llave y dominio: **no son válidos en producción**. Se accede al historial con login y se generan/enlazan nuevos recursos desde producción. La fuente/respaldos conservan las referencias originales.
- Los perfiles Chrome de los agentes se copian íntegros a volúmenes independientes. Que los bytes coincidan no prueba que un tercero mantenga vigente su login; validar después del corte y volver a autenticar sólo donde haga falta. No copiar sesiones del Chrome/Dia personal de Angel.
- Mantener desarrollo sin servidor/web/bridge activos después de admitir tráfico en producción; no permitir dos agendas ni dos copias activas del mismo trabajo. Se conservan sus bases, archivos, volúmenes y configuración. Reactivarlo sólo como recuperación o con una política explícita de desarrollo independiente.

## Preparación local de la operación y estado pendiente

Angel pidió continuar preparando la operación y **dejar los respaldos pendientes**. No se interpreta como permiso para omitirlos, aceptar el riesgo offsite o ejecutar el corte. No activar S3, inicializar repositorios, subir material, tomar nuevas copias ni cambiar el backup diario durante esta preparación.

```sh
just cutover plan      # catálogo de argv para revisión, hashes de entradas y gates; sólo local
just cutover rehearse  # modelo sintético de secuencia/fallos; cero SSH/DB/Docker/backups
```

`plan` fija por hash el candidato, configuración de release, decisión de imágenes, módulos de transformación y SQL de drenado. Muestra los destinos separados y los comandos exactos previstos para parar únicamente bridge/web/server y arrancar sólo `server` con `--no-deps --no-build --pull never`. No se usa `--wait`: la comprobación de salud será específica del servidor, no de servicios ajenos del proyecto. El cambio futuro de `backup` se lista como pendiente, no se ejecuta. Los argv son para **reko-3/context default**, no para ejecutar Docker localmente en el Mac. Nada en estos comandos toma secretos como valores de argumentos; el archivo privado de Komodo sigue en el host.

**Límite importante:** esto es un catálogo concreto y un modelo de control, no el executor remoto del corte. `just cutover apply` falla siempre, aun cambiando `deploymentEnabled`; no abre SSH ni lee credenciales. La implementación/integración de mantenimiento, promoción del destino, aceptación y recuperación reales sigue pendiente. No presentar el modelo como ensayo Docker/Traefik/DBOS ni como operación completa lista para producción.

El modelo valida antes de cualquier interrupción: política de respaldos resuelta, autorización de ventana, CI exacto/plan vigente y destinos ausentes. Los hechos del ensayo son fixtures inventadas, no recibos ni autorizaciones reales. En cada etapa registra intento antes de resultado: timeout implica estado incierto, nunca permiso para reintentar o volver atrás automáticamente. A partir del **intento de arranque del destino** puede haber nuevas escrituras/recuperación de trabajo, antes incluso de la aceptación o de abrir el dominio al público; desde ahí la recuperación requiere comprobar/reconciliar lo ocurrido, no conmutar ciegamente a la DB anterior. El journal del modelo es sólo memoria del ensayo: el executor futuro necesitará persistencia privada/durable en reko-3 y reconciliación después de desconexión.

### Drenado concreto, sin fabricar ceros

[`drain.sql`](../scripts/deploy/drain.sql), usado como stdin de los dos comandos `drain` del catálogo, exige conexión read-only a `agents`. Cuenta corridas activas, mensajes sin rutear, entregas pendientes y **leases de chat/validación de diseños**, además de agrupar los estados DBOS. Las leases vencidas todavía presentes bloquean: no borrarlas automáticamente para pasar la comprobación. No basta mirar sólo `runs`.

El operador debe añadir `sandboxWriters` con los filtros `agents.instance=dev|prod`, verificar los volúmenes montados y descartar escritores fuera de esos labels. No contar automáticamente una consulta ausente/fallida como cero. `drained()` rechaza datos ausentes, negativos/no enteros, estados DBOS no terminales/desconocidos y fuentes incompletas. Repetir la observación con los escritores ya detenidos: si aparece trabajo nuevo entre las dos observaciones, no tomar snapshot ni promover destino; conservar mantenimiento y decidir la recuperación del origen.

Para integrar el executor faltan comprobaciones reales que el catálogo no simula:

- Mantenimiento temporal por ambos hosts con prioridad explícita, respuesta 503/no-store y comprobación desde fuera. Un cambio de router de Traefik **no prueba** cierre de conexiones HTTP/WebSocket ya abiertas; resolverlas y volver a comprobar drenado. Mantener operativos los callbacks internos de sandboxes y `/llm` hasta terminar tareas.
- Detener el bridge antes del drenado; impedir nuevas admisiones programadas durante la ventana. Si se aprueba pausar agendas de origen, guardar/restaurar sus estados exactos y comprobar que ya no producen trabajo; no borrar historia, no activar backfill, no atribuir esa autorización a este ensayo. El apagado de servidores debe comprobarse por ID/estado reales, no por el retorno del cliente Docker.
- Estado original privado: IDs/imágenes/inicios, definición/configuración del stack, routing, estados de agendas y qué servicios estaban activos. Recuperar únicamente esos servicios tras fallo pre-escrituras; no arrancar genéricamente todos los de dev.
- Preparación de `agents_beta1`, data y 9 volúmenes nuevos exclusivamente desde el snapshot coordinado final verificado. Reusar la transformación de ensayo, pero **no** promover un ensayo online antiguo. Comprobar existencia y contenido antes de que Compose/app puedan autocrear volúmenes o directorios vacíos; no tocar DB/data originales.
- Aceptación privada con dueño y autoridad de inferencia/efectos externos definida, cron destino pausado y origen apagado. Una tarea controlada puede crear historial, gastar cuota y disparar callbacks: es ya el límite de nuevas escrituras.

No se ejecutan estas acciones ni se generan respaldos para completar el modelo. El transporte S3 permanece opt-in/deshabilitado; el respaldo coordinado y el cambio del backup a la DB nueva quedan explícitamente sin hacer.

## Antes de autorizar una ventana

- CI exacto del HEAD de PR #4, sin saltos; revisión del candidato contra la configuración **actual** de Komodo. Los ensayos previos no congelan los datos vivos.
- Confirmar impacto de nuevas invitaciones/enlaces y disponibilidad del administrador para entregarlas por canal privado, nunca en documentos/logs de Bubble.
- La copia de `AGENTS_MASTER_KEY` en `1Password → Cuby → agents` ya se comparó con la efectiva/archivo de producción y coincide (31-oct-2026, 17:40:35 UTC). Falta configurar y verificar una copia **cifrada offsite de los datos**, o aceptar explícitamente el riesgo de recuperación sólo en reko-3. [Cableado S3/restic](backup-s3.md) disponible pero deshabilitado: poner secretos no dispara subidas ni demuestra recuperación. El transporte actual acepta snapshots de ensayo ya terminados y dumps diarios, no genera el respaldo coordinado final del corte. No se ha probado un desastre de host completo; no copiar secretos/backups crudos al Mac.
- Acordar ventana: reservar **15 minutos como presupuesto inicial**, no como duración medida del corte. Si el drenado o las comprobaciones no caben, no ampliar la interrupción silenciosamente: abortar antes de admitir escrituras y reprogramar.
- Obtener autorización explícita de **horario y ejecución del corte**. La autorización previa de usar imágenes beta o continuar ensayos no la sustituye.

## Procedimiento durante la ventana autorizada

Todas las operaciones reales, consultas y cambios se ejecutan visiblemente en `cuby-agents-prod`. Cerrar esa sesión al terminar salvo que Angel esté conectado o pida conservarla. Herramientas Docker con contexto explícito y daemon reko-3 verificado. Nunca secretos en argv/salida; entorno privado 0600.

1. **Preflight fresco.** Verificar artefactos publicados por digest/firma/etiquetas/plataforma, aplicación y schema esperados, Angelk sin nuevos datos incompatibles, alcance Test, llaves efectivas, modelos/proxies, redes/egress, espacio libre y ausencia de destinos `agents_beta1`, directorio beta1 o volúmenes reservados. Si existen, reconciliar estado parcial; no sobreescribir ni reintentar a ciegas. No construir/publicar/prunear imágenes.
2. **Cerrar admisión y drenar.** Avisar a usuarios, bloquear tráfico de escritura de ambos dominios con mantenimiento y elegir un intervalo fuera de la agenda. Esperar corridas activas, inbox sin rutear, entregas pendientes y leases de diseño/validación a cero; verificar estados DBOS terminales, conexiones existentes y escritores de volúmenes. Detener sólo web/server/bridge de dev y server de prod acordados, sin detener PostgreSQL, CLIProxyAPI ni otros stacks. Comprobar otra vez cero trabajo pendiente y ningún sandbox real de esos entornos escribiendo. Si hubo una carrera o quedó trabajo, abortar y recuperar origen; no transportar trabajo a medio ejecutar ni pausar/borrar historia del origen para fabricar drenado.
3. **Respaldo final coordinado.** Con todos esos escritores detenidos: dumps completos de ambas bases (public, dbos y demás schemas), datos/configuración de ambos entornos, 9 volúmenes reales y estado de configuración/routing efectivo. Manifestar checksums/propietarios/permisos, comprobar que no cambian durante copia y restaurar la copia final. Los tar/dumps online anteriores no reemplazan este punto. Conservar originales y backups antiguos.
4. **Preparar destino sin tocar el original.** Repetir la transformación probada sobre el snapshot final: exclusión acotada de Test, recifrado hacia la llave de prod, identidad Angelk separada, revisiones nuevas de activos, tratamiento DBOS y filtrado de datos. Restaurar en `agents_beta1`, `/srv/agents/releases/beta1/data` y los 9 volúmenes nuevos. Verificar hashes/ACL/xattrs, relaciones, campos cifrados, definiciones/historia conservada, shares, secuencias y correspondencia de cada `state_ref`. No arrancar con volúmenes vacíos creados automáticamente.
5. **Validar con admisión cerrada.** Pausar agendas sólo en destino; arrancar app beta con la llave/PIN/proxy key de producción, versión DBOS `v2`, nuevas DB/data y digests fijos. Comprobar `/healthz` SHA/version, web, autenticación/visibilidad, datos/archivos, proxy y rutas. Validar un perfil y una tarea corta controlada con dueño disponible antes de abrir al resto; esta aceptación puede requerir login externo e inferencia autorizada, no está probada por el ensayo offline. No fabricar aprobación de contratos ni subir credenciales como evidencia.
6. **Admitir y respaldar la nueva DB.** Tras aceptación, mantener origen detenido, restaurar estados esperados de agendas en destino sin backfill y abrir dominio de producción. Cambiar el servicio `backup` a `agents_beta1`, prefijo `agents-beta1-`, manteniendo PGDATA y dumps originales. Comprobar que el primer dump nuevo es restaurable y dejar monitorización/evidencia. Aplicar sólo cambios aprobados de server/backup/routing; no `down`, `--remove-orphans`, pruning, ni recreación general del stack.
7. **Entregar accesos y cerrar.** Invitaciones privadas para usuarios existentes, actualizar emisores de hooks al nuevo dominio, verificar propiedad/billing/perfiles y confirmar que sólo producción agenda/ejecuta. Registrar evidencia sin secretos, estado de dev detenido y qué se conserva. No borrar ni prunear origen, DB original, backups o imágenes en esta ventana.

El procedimiento es una especificación para el operador: el entrypoint de preparación **no implementa apply** ni envía estos pasos a producción. Antes de ejecutar se necesita el script/operación concreta revisada contra el estado final; el candidato Compose por sí solo no hace migración ni drenado.

## Abortar y recuperar

| Momento                                                                 | Acción y límite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antes de cambiar admisión/servicios                                     | No hay interrupción ni cambio de datos; limpiar sólo temporales propios.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tras detener origen, antes de abrir destino a escrituras                | Mantener destino sin tráfico y con agendas pausadas, detener su app, restaurar configuración/routing originales y arrancar únicamente los servicios detenidos del origen/prod. Las bases/volúmenes originales permanecen intactos. Revalidar estado durable y accesos. No borrar los destinos fallidos: conservar evidencia privada.                                                                                                                                                                  |
| Desde el intento de arranque del destino, aceptación o admisión pública | **No volver ciegamente a la DB anterior, aunque el dominio aún esté en mantenimiento.** El arranque/recuperación o la tarea de aceptación pueden haber escrito/generado efectos externos; un timeout no prueba que no lo hicieron. Cerrar admisión, detener escritores y respaldar destino, identificar delta/datos nuevos y acordar recuperación antes de volver atrás. El rollback puede necesitar restaurar el dump final y reconciliar el delta. No está automatizado ni se promete cero pérdida. |
| Imagen/revisión histórica ausente                                       | No hay rollback ejecutable a ese pin. El ensayo demuestra recuperación de datos con la beta publicada, no resucita los dos pins históricos perdidos. Recuperar su artefacto o aprobar/probar una nueva revisión es otra decisión.                                                                                                                                                                                                                                                                     |

Si cualquier validación falla, no publicar otra release como arreglo improvisado, no regenerar llaves, no activar trabajos/cron ni abrir tráfico para “ver si funciona”. Conservar el estado parcial y dar a Angel causa, alcance e intento de recuperación antes de continuar.
