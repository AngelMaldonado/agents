# Preparación del traslado a v0.0.1-beta

**Preparación, no despliegue.** Desarrollo contiene las personas/agentes reales. Producción contiene una identidad distinta, Angelk, sin agentes. El encargo confirmado es desarrollo → producción, excluyendo Test y sus 9 agentes del destino, sin borrar el origen. Se conserva Angelk por separado: no se fusiona con Angel aunque ambos tengan ID 2 en sus bases actuales.

```text
DEV Postgres (lectura) ── dump ──► Postgres temporal, sin red
PROD Postgres (lectura) ─ dump ──► segunda base temporal
                                  │ excluir Test y sus agentes de public
                                  │ conservar personas/agentes/históricos reales
                                  │ recifrar secretos con la llave de producción
                                  │ incorporar Angelk con nuevo ID y sus accesos
                                  └ comprobar invariantes → destruir bases temporales

Volúmenes/datos (readonly) ── tar privado ──► volúmenes temporales
                                            └ restaurar y comparar → destruir copias

Harness de cada agente ──► sandbox beta sin red, perfiles ni secretos inyectados
                          └ prueba de pi/herramientas ligada a imagen y manifiesto
                            └ nueva revisión de activos SÓLO en la base temporal
```

## Comandos

Desde el worktree de preparación, `~/dev/work/agents-release-setup`:

```sh
just deploy plan
just deploy inspect
just deploy rehearse
```

- `plan` no hace operaciones remotas. `inspect` consulta metadatos y busca los dos pins existentes entre manifiestos OCI de los repositorios sandbox conocidos en el Zot de reko-3.
- `inspect` y `rehearse` abren ventanas en `cuby-agents-prod`, sin tomar la ventana actual. Se crea la sesión si falta. Ver con `tmux attach -t cuby-agents-prod`.
- SSH/daemon son exclusivamente reko-3; Docker recibe contexto explícito. Los contenedores nuevos usan artefactos fijados y `--pull=never`, sin red, límites de recursos y etiquetas por ejecución; no montan el socket Docker ni ejecutan el servidor de Agents.
- El manifiesto auditado se obtiene del asset inmutable de GitHub si no está en `.release/verify-first-release/release-manifest.json`. Su SHA-256 debe ser `52c9dbd1124134774806312a53e3aff81766af6da440654db6d56d2fae383b3c`. Se necesita la autenticación habitual de `gh` sólo si hay que descargarlo.
- El ensayo está deliberadamente limitado a **esta primera beta y su esquema**. No es un migrador universal. Los refs de app, sandbox y herramientas se validan contra los artefactos auditados; se aborta ante estado de origen inesperado, dependencias cruzadas o datos nuevos en producción.

## Lo que verifica

1. Dumps custom de ambas bases con conexiones de origen read-only; restaura en dos bases distintas de un Postgres temporal sin red y con datos en tmpfs.
2. En la copia de desarrollo elimina Test y sus 9 agentes, resolviendo primero borradores/revisiones con FKs sin cascade. Detecta dependencias que harían perder datos de otra persona y aborta.
3. Conserva las definiciones de agentes reales (incluido el retirado), sus counts de corridas y conversaciones. No reinicia perfiles ni cambia las refs de estado. Sólo en la copia temporal, tras pruebas satisfactorias y conforme a la autorización indicada abajo, incrementa la revisión de agentes activos y fija la imagen beta. Los demás campos y el agente retirado quedan intactos.
4. Abre cada campo cifrado restante con la llave del archivo de desarrollo y prueba el recifrado con la llave del archivo de producción. No rota ninguna llave activa. El plaintext existe sólo en memoria del helper en reko-3; no va a Mac, argumentos, informe ni logs.
5. Agrega la identidad existente Angelk sin equipararla a Angel; remapea sus sesiones/invitaciones y conserva timestamps con precisión de Postgres.
6. Respalda los 9 volúmenes reales y los directorios data/cliproxy de ambos entornos. Restaura cada tar en su propio volumen temporal y compara contenido/metadata (incluidos ACL/xattrs). No ejecuta scripts de esos volúmenes ni inicia Chrome.
7. Prueba los 9 manifiestos de harness con pi real en el sandbox beta, sin llamadas a GPT, secretos de agente, perfiles ni volúmenes personales. Vincula cada resultado al hash canónico del manifiesto y al ref/config ID de la imagen. Antes de crear revisiones en la copia exige un probe único y satisfactorio para ese mismo manifiesto e imagen; aborta si falta la revisión actual, diverge su definición fuera de la imagen o hay conflictos. Si la imagen histórica difiere del pin efectivo de origen, registra ambas referencias en `sourceImageDifferences` sin corregir ni reatribuir la aprobación histórica. Conserva sin cambios todas las revisiones históricas. La prueba técnica no se registra como aprobación de los dueños ni modifica `agent_designs.harness_validation`.
8. Destruye sólo recursos temporales de su ejecución, comprobando etiquetas de pertenencia. Conserva respaldos privados y reporta fallos de limpieza.

Los respaldos y archivos de entorno quedan **sólo en reko-3**, bajo `~/.local/state/agents-migration/<ejecución>/` (directorio 0700, archivos privados). Contienen datos sensibles: no subir, copiar a Mac, servir ni adjuntar a Bubble. El informe de Mac `.release/deploy-prepare/<ejecución>.json` contiene sólo metadatos y checksums; no cuerpos, llaves ni secretos cifrados. El hash `operatorSourceSha256` identifica el programa remoto y el worker ejecutados.

## Decisión de imagen autorizada

Angel confirmó: «si, usa los containers que ya estan para la release». La decisión se conserva en `deploy/image-transition.json` y su hash queda en el informe. Se reutilizan **las imágenes publicadas**, sin ejecutar builds, firmas nuevas ni otra release:

- App: `registry.cubytest.space/cuby/agents-app@sha256:8a8d92f6ad22e024e3defba54261e903e60b24e43a18f5efd0d1e13a534916a8`.
- Sandbox: `registry.cubytest.space/cuby/agents-sandbox@sha256:04771072a9d1064e52c034b1f59a1db7c46f695c760568cc9af76d20d5bebd40`.

La nueva revisión usa el config ID inmutable resuelto de ese sandbox por Docker, como el flujo normal de Agents, y el informe conserva también el ref publicado. Sólo cambia `harness_image` y aumenta `config_revision` en los agentes **activos** de la copia; agrega snapshots a `agent_revisions`, nunca sobrescribe los anteriores ni reescribe las definiciones de corridas históricas. Roles/modelos/manifiestos, propiedad/permisos, conversaciones y refs de estado permanecen iguales; el retirado no se reactiva ni se repinea. La autorización se atribuye a **Angel como operador**, no a los dueños. El JSON es evidencia de una decisión revisada, no un servicio de autenticación/autorización ni un permiso de corte.

## Ensayo de la transición autorizada

Evidencia: `deploy/preparation-proof.json`, ejecución `20261031T130556Z-88d57d2b`, con hash del programa/worker y de la decisión ejecutados. Resultado: 8 revisiones nuevas en la copia, 9 probes satisfactorios, agente retirado intacto y revisiones históricas sin cambios. Conservó 7 personas incluyendo Angelk, 9 agentes, 244 corridas y 13 conversaciones; recifró 19 campos y restauró/comparó 13 archivos. La fuente siguió funcionando, por eso sus conteos difieren de ensayos anteriores.

Los dos primeros intentos abortaron y limpiaron recursos temporales por una comprobación que exigía igualdad de imagen efectiva y snapshot histórico. Se confirmó que en 4 agentes esas referencias ya diferían en origen; no se retocó su historia para hacerlas coincidir. El ensayo final registra ambas imágenes como discrepancia previa y limita el cambio nuevo al campo autorizado y su número de revisión. Las definiciones fuera de la imagen sí deben coincidir; de lo contrario aborta.

## Lo que todavía NO verifica ni aplica

- No hay `apply`, `just deploy` sólo muestra el plan y `deploymentEnabled` permanece `false`. No cambia stacks, dominios, imágenes fijadas por agente, llaves activas ni registros de las bases de origen/destino.
- Las copias se toman **online**, con los entornos funcionando. No son un snapshot coordinado DB+filesystem ni un respaldo definitivo de corte; hay que repetir tras acordar cómo impedir nuevas escrituras. Están en el mismo host, no constituyen backup offsite.
- La eliminación ensayada afecta las entidades de aplicación de Test. Aún hay que tratar sus agendas y referencias históricas DBOS y filtrar artefactos huérfanos del directorio de datos en la copia final; no ejecutar esa copia como servidor.
- Las refs de estado aún apuntan a nombres de desarrollo dentro de la base temporal. Falta mapear los volúmenes finales de producción sin que dos instancias escriban el mismo perfil.
- Faltan la política de sesiones web al cambiar de dominio, URLs/webhooks, autenticación/proxy, redes/egress y un compose basado en la configuración real del stack, sin servicio/requisito de WhatsApp. Los perfiles del agente se preservan como archivos; no se ha probado continuidad de login con Chrome ni una tarea real.
- Las imágenes históricas no resuelven por sus pins. Angel ya autorizó usar la beta para nuevas revisiones de activos; esta transición se ensaya sólo en la copia. Los pins históricos y el agente retirado se conservan, por lo que restaurar una revisión antigua todavía exigiría recuperar su imagen o una nueva prueba/autorización; no se promete un rollback ejecutable a imágenes ausentes.
- Antes del corte: verificación criptográfica de los dos digests publicados, ensayo de recuperación, respaldo coordinado actualizado y autorización de Angel. Un rollback de imagen no revierte datos ni recupera imágenes históricas ausentes.

Seguimiento: Bubble, proyecto `agents`, hilo #17. La publicación de artefactos sigue siendo exclusivamente `just release`; preparar no publica ni autoriza el corte.
