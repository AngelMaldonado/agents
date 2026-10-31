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
                          └ prueba de pi/herramientas; NO modifica ni aprueba pins
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
3. Conserva las definiciones de agentes reales (incluido el retirado), sus counts de corridas y conversaciones. No reinicia perfiles ni cambia sus refs/pins.
4. Abre cada campo cifrado restante con la llave del archivo de desarrollo y prueba el recifrado con la llave del archivo de producción. No rota ninguna llave activa. El plaintext existe sólo en memoria del helper en reko-3; no va a Mac, argumentos, informe ni logs.
5. Agrega la identidad existente Angelk sin equipararla a Angel; remapea sus sesiones/invitaciones y conserva timestamps con precisión de Postgres.
6. Respalda los 9 volúmenes reales y los directorios data/cliproxy de ambos entornos. Restaura cada tar en su propio volumen temporal y compara contenido/metadata (incluidos ACL/xattrs). No ejecuta scripts de esos volúmenes ni inicia Chrome.
7. Prueba los 9 manifiestos de harness con pi real en el sandbox beta, sin llamadas a GPT, secretos de agente, perfiles ni volúmenes personales. El resultado es una propuesta técnica, **no una aprobación ni cambio de imagen**.
8. Destruye sólo recursos temporales de su ejecución, comprobando etiquetas de pertenencia. Conserva respaldos privados y reporta fallos de limpieza.

Los respaldos y archivos de entorno quedan **sólo en reko-3**, bajo `~/.local/state/agents-migration/<ejecución>/` (directorio 0700, archivos privados). Contienen datos sensibles: no subir, copiar a Mac, servir ni adjuntar a Bubble. El informe de Mac `.release/deploy-prepare/<ejecución>.json` contiene sólo metadatos y checksums; no cuerpos, llaves ni secretos cifrados. El hash `operatorSourceSha256` identifica el programa remoto y el worker ejecutados.

## Lo que todavía NO verifica ni aplica

- No hay `apply`, `just deploy` sólo muestra el plan y `deploymentEnabled` permanece `false`. No cambia stacks, dominios, imágenes fijadas por agente, llaves activas ni registros de las bases de origen/destino.
- Las copias se toman **online**, con los entornos funcionando. No son un snapshot coordinado DB+filesystem ni un respaldo definitivo de corte; hay que repetir tras acordar cómo impedir nuevas escrituras. Están en el mismo host, no constituyen backup offsite.
- La eliminación ensayada afecta las entidades de aplicación de Test. Aún hay que tratar sus agendas y referencias históricas DBOS y filtrar artefactos huérfanos del directorio de datos en la copia final; no ejecutar esa copia como servidor.
- Las refs de estado aún apuntan a nombres de desarrollo dentro de la base temporal. Falta mapear los volúmenes finales de producción sin que dos instancias escriban el mismo perfil.
- Faltan la política de sesiones web al cambiar de dominio, URLs/webhooks, autenticación/proxy, redes/egress y un compose basado en la configuración real del stack, sin servicio/requisito de WhatsApp. Los perfiles del agente se preservan como archivos; no se ha probado continuidad de login con Chrome ni una tarea real.
- Las imágenes históricas aprobadas no están disponibles por sus pins y no se han sustituido. Si no se recuperan los artefactos exactos, hacen falta prueba y autorización explícita para una nueva revisión, conservando manifiesto/estado y sin fingir aprobaciones de los dueños.
- Antes del corte: verificación criptográfica de los dos digests publicados, ensayo de recuperación, respaldo coordinado actualizado y autorización de Angel. Un rollback de imagen no revierte datos ni recupera imágenes históricas ausentes.

Seguimiento: Bubble, proyecto `agents`, hilo #17. La publicación de artefactos sigue siendo exclusivamente `just release`; preparar no publica ni autoriza el corte.
