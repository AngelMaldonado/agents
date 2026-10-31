# Corte propuesto: desarrollo → producción, primera beta

**Plan para aprobación, no autorización ni operación ejecutada.** `deploymentEnabled=false`; `just deploy` sólo prepara. No repetir `just release`: la beta publicada es el artefacto que se usará. El candidato completo es [`beta.compose.yaml`](beta.compose.yaml); no aplicar el overlay antiguo por separado.

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

## Antes de autorizar una ventana

- CI exacto del HEAD de PR #4, sin saltos; revisión del candidato contra la configuración **actual** de Komodo. Los ensayos previos no congelan los datos vivos.
- Confirmar impacto de nuevas invitaciones/enlaces y disponibilidad del administrador para entregarlas por canal privado, nunca en documentos/logs de Bubble.
- Confirmar custodia recuperable de la llave de producción fuera de esta máquina/host y destino de una copia **cifrada offsite**, o aceptar explícitamente el riesgo de recuperación sólo en reko-3. El ensayo no prueba ese escrow ni un desastre de host completo; no copiar secretos/backups crudos al Mac.
- Acordar ventana: reservar **15 minutos como presupuesto inicial**, no como duración medida del corte. Si el drenado o las comprobaciones no caben, no ampliar la interrupción silenciosamente: abortar antes de admitir escrituras y reprogramar.
- Obtener autorización explícita de **horario y ejecución del corte**. La autorización previa de usar imágenes beta o continuar ensayos no la sustituye.

## Procedimiento durante la ventana autorizada

Todas las operaciones reales, consultas y cambios se ejecutan visiblemente en `cuby-agents-prod`. Cerrar esa sesión al terminar salvo que Angel esté conectado o pida conservarla. Herramientas Docker con contexto explícito y daemon reko-3 verificado. Nunca secretos en argv/salida; entorno privado 0600.

1. **Preflight fresco.** Verificar artefactos publicados por digest/firma/etiquetas/plataforma, aplicación y schema esperados, Angelk sin nuevos datos incompatibles, alcance Test, llaves efectivas, modelos/proxies, redes/egress, espacio libre y ausencia de destinos `agents_beta1`, directorio beta1 o volúmenes reservados. Si existen, reconciliar estado parcial; no sobreescribir ni reintentar a ciegas. No construir/publicar/prunear imágenes.
2. **Cerrar admisión y drenar.** Avisar a usuarios, bloquear tráfico de escritura de ambos dominios con mantenimiento y elegir un intervalo fuera de la agenda. Esperar corridas activas, inbox sin rutear y entregas pendientes a cero; verificar estados DBOS terminales. Detener sólo web/server/bridge de dev y server de prod acordados, sin detener PostgreSQL, CLIProxyAPI ni otros stacks. Comprobar otra vez cero trabajo pendiente y ningún sandbox real de esos entornos escribiendo. Si hubo una carrera o quedó trabajo, abortar y recuperar origen; no transportar trabajo a medio ejecutar ni pausar/borrar historia del origen para fabricar drenado.
3. **Respaldo final coordinado.** Con todos esos escritores detenidos: dumps completos de ambas bases (public, dbos y demás schemas), datos/configuración de ambos entornos, 9 volúmenes reales y estado de configuración/routing efectivo. Manifestar checksums/propietarios/permisos, comprobar que no cambian durante copia y restaurar la copia final. Los tar/dumps online anteriores no reemplazan este punto. Conservar originales y backups antiguos.
4. **Preparar destino sin tocar el original.** Repetir la transformación probada sobre el snapshot final: exclusión acotada de Test, recifrado hacia la llave de prod, identidad Angelk separada, revisiones nuevas de activos, tratamiento DBOS y filtrado de datos. Restaurar en `agents_beta1`, `/srv/agents/releases/beta1/data` y los 9 volúmenes nuevos. Verificar hashes/ACL/xattrs, relaciones, campos cifrados, definiciones/historia conservada, shares, secuencias y correspondencia de cada `state_ref`. No arrancar con volúmenes vacíos creados automáticamente.
5. **Validar con admisión cerrada.** Pausar agendas sólo en destino; arrancar app beta con la llave/PIN/proxy key de producción, versión DBOS `v2`, nuevas DB/data y digests fijos. Comprobar `/healthz` SHA/version, web, autenticación/visibilidad, datos/archivos, proxy y rutas. Validar un perfil y una tarea corta controlada con dueño disponible antes de abrir al resto; esta aceptación puede requerir login externo e inferencia autorizada, no está probada por el ensayo offline. No fabricar aprobación de contratos ni subir credenciales como evidencia.
6. **Admitir y respaldar la nueva DB.** Tras aceptación, mantener origen detenido, restaurar estados esperados de agendas en destino sin backfill y abrir dominio de producción. Cambiar el servicio `backup` a `agents_beta1`, prefijo `agents-beta1-`, manteniendo PGDATA y dumps originales. Comprobar que el primer dump nuevo es restaurable y dejar monitorización/evidencia. Aplicar sólo cambios aprobados de server/backup/routing; no `down`, `--remove-orphans`, pruning, ni recreación general del stack.
7. **Entregar accesos y cerrar.** Invitaciones privadas para usuarios existentes, actualizar emisores de hooks al nuevo dominio, verificar propiedad/billing/perfiles y confirmar que sólo producción agenda/ejecuta. Registrar evidencia sin secretos, estado de dev detenido y qué se conserva. No borrar ni prunear origen, DB original, backups o imágenes en esta ventana.

El procedimiento es una especificación para el operador: el entrypoint de preparación **no implementa apply** ni envía estos pasos a producción. Antes de ejecutar se necesita el script/operación concreta revisada contra el estado final; el candidato Compose por sí solo no hace migración ni drenado.

## Abortar y recuperar

| Momento                                                  | Acción y límite                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Antes de cambiar admisión/servicios                      | No hay interrupción ni cambio de datos; limpiar sólo temporales propios.                                                                                                                                                                                                                                                             |
| Tras detener origen, antes de abrir destino a escrituras | Mantener destino sin tráfico y con agendas pausadas, detener su app, restaurar configuración/routing originales y arrancar únicamente los servicios detenidos del origen/prod. Las bases/volúmenes originales permanecen intactos. Revalidar estado durable y accesos. No borrar los destinos fallidos: conservar evidencia privada. |
| Tras admitir nuevas escrituras en producción             | **No volver ciegamente a la DB anterior.** Cerrar admisión, detener escritores y respaldar destino, identificar delta/datos nuevos y acordar recuperación antes de volver atrás. El rollback puede necesitar restaurar el dump final y reconciliar el delta. No está automatizado ni se promete cero pérdida.                        |
| Imagen/revisión histórica ausente                        | No hay rollback ejecutable a ese pin. El ensayo demuestra recuperación de datos con la beta publicada, no resucita los dos pins históricos perdidos. Recuperar su artefacto o aprobar/probar una nueva revisión es otra decisión.                                                                                                    |

Si cualquier validación falla, no publicar otra release como arreglo improvisado, no regenerar llaves, no activar trabajos/cron ni abrir tráfico para “ver si funciona”. Conservar el estado parcial y dar a Angel causa, alcance e intento de recuperación antes de continuar.
