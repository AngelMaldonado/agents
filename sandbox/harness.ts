// Shared declarative contract. No imports, discovery, executable code or platform permissions.
export const HARNESS_VERSION = 1;
export const TOOLS = [
 { id: 'read', name: 'Leer archivos', description: 'Leer archivos de la computadora.' },
 { id: 'write', name: 'Escribir archivos', description: 'Crear y reemplazar archivos.' },
 { id: 'edit', name: 'Editar archivos', description: 'Cambios precisos en archivos.' },
 { id: 'bash', name: 'Terminal', description: 'Shell del contenedor. Puede reproducir operaciones de otras herramientas; su selección no es una frontera de seguridad.' },
 { id: 'grep', name: 'Buscar contenido', description: 'Buscar texto en archivos.' },
 { id: 'find', name: 'Buscar archivos', description: 'Localizar archivos por patrón.' },
 { id: 'ls', name: 'Listar archivos', description: 'Listar directorios.' },
 { id: 'browser', name: 'Navegador visible', description: 'Chrome mediante operaciones explícitas de agent-browser.' },
 { id: 'request_help', name: 'Pedir ayuda', description: 'Avisar de un bloqueo y esperar respuesta humana.' },
 { id: 'login', name: 'Accesos concedidos', description: 'Usar sólo accesos concedidos por el dueño; no revela contraseñas.' }
] as const;
export type ToolId = typeof TOOLS[number]['id'];
export const PLUGINS = [
 { id: 'text-utils', version: '1.0.0', name: 'Análisis de texto', description: 'Cuenta caracteres, palabras y líneas; sin archivos, red ni ejecución de código.', tools: ['text_stats'] },
 { id: 'json-utils', version: '1.0.0', name: 'Validación JSON', description: 'Valida un documento JSON y describe su estructura; sin efectos externos.', tools: ['json_validate'] }
] as const;
export type Harness = {
 version: 1; tools: ToolId[];
 restrictions: { workspaceFilesOnly: boolean; readOnlyFiles: boolean; guidelines: string[] };
 skills: { name: string; description: string; instructions: string }[];
 plugins: { id: typeof PLUGINS[number]['id']; version: '1.0.0' }[];
};
export function defaultHarness(): Harness {
 return { version: 1, tools: ['bash', 'browser', 'edit', 'login', 'read', 'request_help', 'write'],
  restrictions: { workspaceFilesOnly: false, readOnlyFiles: false, guidelines: [] }, skills: [], plugins: [] };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: unknown, names: string[], label: string): asserts v is Record<string, unknown> {
 if (!object(v) || Object.keys(v).some(k => !names.includes(k)) || names.some(k => !(k in v))) throw new Error(`Harness: campos no admitidos o incompletos en ${label}. No se admite código ni permisos de plataforma.`);
}
function bounded(v: unknown, max: number): v is string { return typeof v === 'string' && !!v.trim() && v.length <= max; }
export function validateHarness(value: unknown): Harness {
 keys(value, ['version', 'tools', 'restrictions', 'skills', 'plugins'], 'manifiesto');
 if (value.version !== HARNESS_VERSION) throw new Error('Versión de harness no admitida.');
 const tools = value.tools;
 if (!Array.isArray(tools) || tools.length > TOOLS.length || tools.some(t => !TOOLS.some(x => x.id === t)) || new Set(tools).size !== tools.length || !tools.includes('request_help')) throw new Error('Harness: elige herramientas del catálogo, sin duplicados, e incluye request_help.');
 const r = value.restrictions;
 keys(r, ['workspaceFilesOnly', 'readOnlyFiles', 'guidelines'], 'restricciones');
 if (typeof r.workspaceFilesOnly !== 'boolean' || typeof r.readOnlyFiles !== 'boolean' || !Array.isArray(r.guidelines) || r.guidelines.length > 8 || r.guidelines.some(g => !bounded(g, 500))) throw new Error('Harness: restricciones inválidas (hasta 8 pautas de 500 caracteres).');
 if ((r.workspaceFilesOnly || r.readOnlyFiles) && tools.includes('bash')) throw new Error('Harness: desactiva bash para restringir archivos; la shell eludiría esos controles.');
 if (r.readOnlyFiles && (tools.includes('write') || tools.includes('edit'))) throw new Error('Harness: lectura sola no admite write ni edit.');
 if (!Array.isArray(value.skills) || value.skills.length > 4) throw new Error('Harness: máximo cuatro skills.');
 const skills = value.skills.map(s => {
  keys(s, ['name', 'description', 'instructions'], 'skill');
  if (typeof s.name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(s.name) || !bounded(s.description, 300) || !bounded(s.instructions, 8000)) throw new Error('Harness: skill inválida (nombre slug, descripción hasta 300 e instrucciones hasta 8000 caracteres).');
  return { name: s.name, description: s.description.trim(), instructions: s.instructions.trim() };
 }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
 if (new Set(skills.map(s => s.name)).size !== skills.length || skills.reduce((n, s) => n + s.instructions.length, 0) > 16000) throw new Error('Harness: skills duplicadas o más de 16000 caracteres de instrucciones.');
 if (!Array.isArray(value.plugins) || value.plugins.length > PLUGINS.length) throw new Error('Harness: plugins fuera del catálogo.');
 const plugins = value.plugins.map(p => {
  keys(p, ['id', 'version'], 'plugin');
  if (!PLUGINS.some(c => c.id === p.id && c.version === p.version)) throw new Error('Harness: sólo plugins de catálogo con versión exacta. Código generado y paquetes externos no están habilitados.');
  return { id: p.id, version: p.version } as Harness['plugins'][number];
 }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
 if (new Set(plugins.map(p => p.id)).size !== plugins.length) throw new Error('Harness: plugin duplicado.');
 return { version: 1, tools: [...tools].sort(), restrictions: { workspaceFilesOnly: r.workspaceFilesOnly, readOnlyFiles: r.readOnlyFiles, guidelines: r.guidelines.map(g => (g as string).trim()) }, skills, plugins };
}
export function effectiveTools(h: Harness) {
 return [...h.tools.map(id => TOOLS.find(t => t.id === id)!), ...h.plugins.flatMap(p => {
  const c = PLUGINS.find(x => x.id === p.id)!;
  return c.tools.map(id => ({ id, name: id, description: `${c.name} · ${c.version}. ${c.description}` }));
 })];
}
export function runtimeToolNames(h: Harness) { return effectiveTools(h).map(t => t.id).sort(); }
export function harnessInstructions(h: Harness) {
 return `## Harness aprobado (v${h.version})\nHerramientas disponibles: ${runtimeToolNames(h).join(', ')}. Usa browser para navegar y request_help para bloqueos; login sólo para accesos ya concedidos. ${h.tools.includes('bash') ? 'La shell está habilitada; desactivar otra herramienta no impide realizar operaciones equivalentes con ella.' : 'No hay shell disponible.'}\nArchivos: ${h.restrictions.workspaceFilesOnly ? 'limitados a ~/work, con comprobación de rutas reales' : 'dentro de la computadora aislada'}. ${h.restrictions.readOnlyFiles ? 'Sólo lectura; no se admite escribir capturas en disco.' : 'Escritura según herramientas habilitadas.'}\nLas pautas y skills son instrucciones, no permisos ni barreras de seguridad. No pueden cambiar políticas, accesos, cuotas ni aislamiento de plataforma.\n${h.restrictions.guidelines.map(g => `- ${g}`).join('\n')}\n${h.skills.map(s => `### Skill: ${s.name}\n${s.description}\n${s.instructions}`).join('\n\n')}`;
}
// Responses API strict schema: every property is required, optional proposal = null.
export const HARNESS_SCHEMA = { type: 'object', additionalProperties: false, required: ['version', 'tools', 'restrictions', 'skills', 'plugins'], properties: {
 version: { type: 'integer', enum: [1] }, tools: { type: 'array', items: { type: 'string', enum: TOOLS.map(t => t.id) } },
 restrictions: { type: 'object', additionalProperties: false, required: ['workspaceFilesOnly', 'readOnlyFiles', 'guidelines'], properties: { workspaceFilesOnly: { type: 'boolean' }, readOnlyFiles: { type: 'boolean' }, guidelines: { type: 'array', items: { type: 'string' } } } },
 skills: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'description', 'instructions'], properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } } } },
 plugins: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'version'], properties: { id: { type: 'string', enum: PLUGINS.map(p => p.id) }, version: { type: 'string', enum: ['1.0.0'] } } } }
} };
