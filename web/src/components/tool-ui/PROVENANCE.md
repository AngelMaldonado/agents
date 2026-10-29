# Tool UI — QuestionFlow

Fuente: https://www.tool-ui.com/docs/question-flow y https://www.tool-ui.com/r/question-flow.json, consultados el 28-oct-2026. Código oficial de https://github.com/assistant-ui/tool-ui, licencia MIT conservada en `LICENSE.md`. Se copia como componente fuente, conforme al modelo de distribución de Tool UI/shadcn; no es un componente dibujado de nuevo ni un servicio remoto.

Adaptaciones locales: español; sin min-width fijo que desborde a 320 px; opciones que permiten wrap; nombres accesibles y foco de preguntas; valor/paso controlados y slot de respuesta libre/validación. Estos controles se integran con persistencia y autorización de Agents. No ejecutan una herramienta del agente ni conceden permisos.

`QuestionFlow` queda dentro del mensaje de assistant-ui sobre el ExternalStoreRuntime existente. Las respuestas de rondas completadas se guardan en Postgres; las selecciones/texto aún sin enviar permanecen en memoria al alternar modo o ancho. Recargar conserva las rondas completadas, no los cambios sin enviar ni una petición fallida. Ante fallo, los valores se mantienen en memoria para reintentar sin recargar.
