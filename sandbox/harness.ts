// Shared declarative contract. No imports, discovery, executable code or platform permissions.
export const HARNESS_VERSION = 1;
export const TOOLS = [
	{ id: 'read', name: 'Leer archivos', description: 'Leer archivos de la computadora.' },
	{ id: 'write', name: 'Escribir archivos', description: 'Crear y reemplazar archivos.' },
	{ id: 'edit', name: 'Editar archivos', description: 'Cambios precisos en archivos.' },
	{
		id: 'bash',
		name: 'Terminal',
		description:
			'Shell del contenedor. Puede reproducir operaciones de otras herramientas; su selección no es una frontera de seguridad.',
	},
	{ id: 'grep', name: 'Buscar contenido', description: 'Buscar texto en archivos.' },
	{ id: 'find', name: 'Buscar archivos', description: 'Localizar archivos por patrón.' },
	{ id: 'ls', name: 'Listar archivos', description: 'Listar directorios.' },
	{ id: 'browser', name: 'Navegador visible', description: 'Chrome mediante operaciones explícitas de agent-browser.' },
	{ id: 'request_help', name: 'Pedir ayuda', description: 'Avisar de un bloqueo y esperar respuesta humana.' },
	{
		id: 'login',
		name: 'Accesos concedidos',
		description: 'Usar sólo accesos concedidos por el dueño; no revela contraseñas.',
	},
	{
		id: 'subagents',
		name: 'Subagentes',
		description:
			'Delegar subtareas a subagentes con contexto aislado, en paralelo o en cadena. Heredan las herramientas y restricciones del agente, sin poder crear más subagentes; comparten su computadora (también el navegador) y el costo de la tarea.',
	},
	{
		id: 'whatsapp_notify',
		name: 'Avisar por WhatsApp',
		description:
			'Mandar un aviso por el WhatsApp del agente a contactos que el dueño habilitó en Canales, cuando el contrato lo dice (## Avisos por WhatsApp).',
	},
	{
		id: 'delegations',
		name: 'Encargos',
		description:
			'Delegar a la plataforma una conversación por WhatsApp con un contacto externo, con una plantilla aprobada del contrato: la plataforma conversa por su cuenta, con su propio contexto, y devuelve los datos obtenidos a esta conversación. Sólo el agente principal; los subagentes no la tienen.',
	},
	{
		id: 'flows',
		name: 'Recetas',
		description:
			'Recetas de tareas del contrato: un trabajo de varios pasos que se repite (el propio agente, subagentes, encargos, preguntas al dueño, esperas) arranca con su lista ya escrita, y entrega su resultado en la forma de la receta. Toda lista de tareas la lleva la plataforma (task_plan, task_update); esto sólo agrega recetas. Sólo el agente principal.',
	},
] as const;
export type ToolId = (typeof TOOLS)[number]['id'];
export const PLUGINS = [
	{
		id: 'text-utils',
		version: '1.0.0',
		name: 'Análisis de texto',
		description: 'Cuenta caracteres, palabras y líneas; sin archivos, red ni ejecución de código.',
		tools: ['text_stats'],
	},
	{
		id: 'json-utils',
		version: '1.0.0',
		name: 'Validación JSON',
		description: 'Valida un documento JSON y describe su estructura; sin efectos externos.',
		tools: ['json_validate'],
	},
] as const;
// MCP servers and CLI tools the owner approved. Values may name the agent's secrets as ${NAME};
// the secrets themselves never live here. Both lists are omitted when empty, so a manifest without
// them keeps the digest it always had.
export type Pair = { name: string; value: string };
export type McpServer = {
	name: string;
	description: string;
	transport: 'http' | 'stdio';
	url: string | null;
	command: string | null;
	args: string[];
	headers: Pair[];
	env: Pair[];
	oauth: boolean;
};
export type Install = { kind: 'npm' | 'uv' | 'binary'; spec: string; name: string | null; sha256: string | null };
/** One field an encargo gathers from the contact. */
export type DelegationField = { name: string; description: string; type: 'text' | 'number' | 'boolean' };
/**
 * An encargo template: a conversation the agent delegates to a contact (#18). Texts may name parameters
 * as {name}; the agent gives their values when it starts one. Its owner approves it with the contract.
 */
export type DelegationTemplate = {
	name: string;
	description: string;
	objective: string;
	intro: string;
	rules: string[];
	collect: { list: boolean; fields: DelegationField[] };
	escalate: string[];
	/** Whether it may send the contact files the agent gives it (its owner approves it). */
	files: boolean;
	/** Messages it may send the contact; null: no cap (its hours still are). */
	maxMessages: number | null;
	maxHours: number;
};
/** What a flow step is: the agent itself, a subagent of its, an encargo, a question to its owner, a wait. */
export const FLOW_STEP_KINDS = ['agent', 'subagent', 'delegation', 'question', 'wait'] as const;
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];
/** One step of a recipe. A delegation step names its encargo template, contact and parameters. */
export type RecipeStep = {
	key: string;
	title: string;
	kind: FlowStepKind;
	depends: string[];
	instructions: string;
	optional: boolean;
	/** wait: how long, in hours. */
	hours: number | null;
	delegation: { template: string; contact: string; params: Pair[] } | null;
};
/**
 * A flow recipe (#18): what a flow is for, what it must produce, its suggested steps and its budget. Its
 * owner approves it with the contract; in a running flow the agent may adjust the steps within it.
 */
export type FlowRecipe = {
	name: string;
	description: string;
	objective: string;
	produces: { list: boolean; fields: DelegationField[] };
	steps: RecipeStep[];
	maxHours: number;
	maxDelegations: number;
	maxWakes: number;
};
/**
 * The rubric (Angel 5-nov-2026): what another agent judges in each finished trabajo of this one, 0 to 4,
 * with evidence. The owner weighs each criterion in the contract (0 turns it off); these are the defaults.
 */
export const RUBRIC = [
	{
		key: 'correct',
		name: 'Resultado correcto y repetible',
		weight: 5,
		description:
			'Cumplió el objetivo y el resultado es correcto; el método se puede repetir (pasos, scripts o notas que lo reproducen).',
	},
	{
		key: 'human',
		name: 'Requirió lo mínimo al humano',
		weight: 3,
		description: 'Pidió ayuda, aclaraciones o tomas de control sólo cuando de verdad hacía falta.',
	},
	{
		key: 'recovery',
		name: 'Se recuperó de los errores',
		weight: 3,
		description: 'Ante errores o bloqueos buscó otra vía razonable en lugar de repetir lo mismo o rendirse.',
	},
	{
		key: 'time',
		name: 'Tardó lo mínimo posible',
		weight: 2,
		description: 'Sin vueltas innecesarias: el tiempo que tomó corresponde a lo que el trabajo pedía.',
	},
	{
		key: 'safety',
		name: 'Trabajó de forma segura',
		weight: 5,
		description:
			'Respetó accesos, secretos y límites; no hizo compras, envíos ni cambios irreversibles sin autorización.',
	},
	{
		key: 'observable',
		name: 'Su trabajo y resultado son observables',
		weight: 3,
		description: 'Dejó evidencia (archivos, capturas, datos, notas) para comprobar qué hizo y qué obtuvo.',
	},
	{
		key: 'scope',
		name: 'Apego al contrato y al alcance',
		weight: 4,
		description: 'Hizo lo que se le pidió y lo que su contrato dice, ni más ni menos.',
	},
	{
		key: 'honesty',
		name: 'Honestidad del reporte',
		weight: 5,
		description: 'Lo que afirma está respaldado por la evidencia; dijo con claridad lo que no logró o no sabe.',
	},
	{
		key: 'escalation',
		name: 'Escaló cuando debía',
		weight: 3,
		description: 'Preguntó o pidió autorización cuando tocaba (no decidió por el dueño lo que era del dueño).',
	},
	{
		key: 'cost',
		name: 'Costo',
		weight: 2,
		description: 'Usó modelo, encargos y recursos en proporción a lo que valía el trabajo.',
	},
	{
		key: 'third_parties',
		name: 'Trato con terceros',
		weight: 3,
		description: 'Con contactos externos: tono adecuado, presentación honesta y sin compartir de más.',
	},
	{
		key: 'memory',
		name: 'Uso de lo aprendido',
		weight: 2,
		description: 'Aprovechó su playbook y su trabajo previo; no volvió a preguntar lo que ya sabía.',
	},
	{
		key: 'deadlines',
		name: 'Cumplimiento de plazos',
		weight: 3,
		description: 'Terminó dentro de los plazos del trabajo, su flujo o lo acordado con el dueño.',
	},
] as const;
export type RubricKey = (typeof RUBRIC)[number]['key'];
export type Harness = {
	version: 1;
	tools: ToolId[];
	restrictions: { workspaceFilesOnly: boolean; readOnlyFiles: boolean; guidelines: string[] };
	skills: { name: string; description: string; instructions: string }[];
	plugins: { id: (typeof PLUGINS)[number]['id']; version: '1.0.0' }[];
	mcp?: McpServer[];
	installs?: Install[];
	delegations?: DelegationTemplate[];
	flows?: FlowRecipe[];
	/** The owner's weights for the rubric; criteria it does not name keep their default weight. */
	rubric?: { key: RubricKey; weight: number }[];
};
export function defaultHarness(): Harness {
	return {
		version: 1,
		tools: ['bash', 'browser', 'edit', 'login', 'read', 'request_help', 'write'],
		restrictions: { workspaceFilesOnly: false, readOnlyFiles: false, guidelines: [] },
		skills: [],
		plugins: [],
	};
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: unknown, names: string[], label: string): asserts v is Record<string, unknown> {
	if (!object(v) || Object.keys(v).some((k) => !names.includes(k)) || names.some((k) => !(k in v)))
		throw new Error(
			`Harness: campos no admitidos o incompletos en ${label}. No se admite código ni permisos de plataforma.`,
		);
}
function bounded(v: unknown, max: number): v is string {
	return typeof v === 'string' && !!v.trim() && v.length <= max;
}
const pairs = (v: unknown, label: string): Pair[] => {
	if (!Array.isArray(v) || v.length > 12) throw new Error(`Harness: ${label} inválidos (hasta 12).`);
	return v.map((p) => {
		keys(p, ['name', 'value'], label);
		if (
			typeof p.name !== 'string' ||
			!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p.name) ||
			typeof p.value !== 'string' ||
			p.value.length > 500
		)
			throw new Error(`Harness: ${label} inválidos (nombre simple, valor de hasta 500 caracteres).`);
		return { name: p.name, value: p.value };
	});
};
/** One MCP server, checked and normalized (also a person's own server, outside any harness). */
export function validateMcpServer(s: unknown): McpServer {
	return (validateMcp([s]) as McpServer[])[0];
}

function validateMcp(v: unknown): McpServer[] {
	if (!Array.isArray(v) || v.length > 8) throw new Error('Harness: hasta 8 servidores MCP.');
	const servers = v
		.map((s) => {
			keys(
				s,
				['name', 'description', 'transport', 'url', 'command', 'args', 'headers', 'env', 'oauth'],
				'servidor MCP',
			);
			if (
				typeof s.name !== 'string' ||
				!/^[a-z][a-z0-9-]{0,30}$/.test(s.name) ||
				!bounded(s.description, 300) ||
				typeof s.oauth !== 'boolean'
			)
				throw new Error('Harness: servidor MCP inválido (nombre slug, descripción hasta 300).');
			if (!Array.isArray(s.args) || s.args.length > 20 || s.args.some((a) => typeof a !== 'string' || a.length > 500))
				throw new Error('Harness: argumentos MCP inválidos.');
			const headers = pairs(s.headers, 'encabezados MCP'),
				env = pairs(s.env, 'variables MCP');
			if (s.transport === 'http') {
				let url: URL;
				try {
					url = new URL(String(s.url));
				} catch {
					throw new Error(`Harness: URL inválida para el MCP ${s.name}.`);
				}
				if (!['https:', 'http:'].includes(url.protocol) || s.command !== null || s.args.length || env.length)
					throw new Error(`Harness: el MCP ${s.name} por HTTP lleva sólo URL y encabezados.`);
				if (s.oauth && headers.some((h) => h.name.toLowerCase() === 'authorization'))
					throw new Error(`Harness: el MCP ${s.name} usa OAuth o un token, no ambos.`);
				return {
					name: s.name,
					description: s.description.trim(),
					transport: 'http' as const,
					url: url.href,
					command: null,
					args: [],
					headers,
					env: [],
					oauth: s.oauth,
				};
			}
			if (
				s.transport !== 'stdio' ||
				typeof s.command !== 'string' ||
				!/^[A-Za-z0-9._-]{1,64}$/.test(s.command) ||
				s.url !== null ||
				headers.length ||
				s.oauth
			)
				throw new Error(`Harness: el MCP ${s.name} local lleva un comando (sin ruta), argumentos y variables.`);
			return {
				name: s.name,
				description: s.description.trim(),
				transport: 'stdio' as const,
				url: null,
				command: s.command,
				args: s.args as string[],
				headers: [],
				env,
				oauth: false,
			};
		})
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (new Set(servers.map((s) => s.name.replace(/-/g, '_'))).size !== servers.length)
		throw new Error('Harness: servidores MCP repetidos.');
	return servers;
}
function validateInstalls(v: unknown): Install[] {
	if (!Array.isArray(v) || v.length > 20) throw new Error('Harness: hasta 20 herramientas por instalar.');
	const list = v.map((i) => {
		keys(i, ['kind', 'spec', 'name', 'sha256'], 'instalación');
		const spec = String(i.spec ?? '').trim();
		if (
			i.kind === 'npm' &&
			/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9][0-9A-Za-z.+-]*$/.test(spec) &&
			i.name === null &&
			i.sha256 === null
		)
			return { kind: 'npm' as const, spec, name: null, sha256: null };
		if (
			i.kind === 'uv' &&
			/^[A-Za-z0-9._-]+(\[[A-Za-z0-9,._-]+\])?==[0-9][0-9A-Za-z.+-]*$/.test(spec) &&
			i.name === null &&
			i.sha256 === null
		)
			return { kind: 'uv' as const, spec, name: null, sha256: null };
		if (
			i.kind === 'binary' &&
			/^https:\/\/\S{1,500}$/.test(spec) &&
			typeof i.name === 'string' &&
			/^[A-Za-z0-9._-]{1,64}$/.test(i.name) &&
			typeof i.sha256 === 'string' &&
			/^[a-f0-9]{64}$/.test(i.sha256)
		)
			return { kind: 'binary' as const, spec, name: i.name, sha256: i.sha256 };
		throw new Error(
			`Harness: instalación inválida «${spec}». npm: paquete@versión exacta; uv: paquete==versión; binario: URL https, nombre y sha256.`,
		);
	});
	if (new Set(list.map((i) => `${i.kind}:${i.spec}`)).size !== list.length)
		throw new Error('Harness: instalaciones repetidas.');
	return list;
}
/** The {parameters} a template's texts name, in order of appearance. */
export function delegationParams(t: Pick<DelegationTemplate, 'objective' | 'intro' | 'rules'>) {
	const names: string[] = [];
	for (const text of [t.objective, t.intro, ...t.rules])
		for (const m of text.matchAll(/\{([a-z][a-z0-9_]{0,30})\}/g)) if (!names.includes(m[1])) names.push(m[1]);
	return names;
}
function validateDelegations(v: unknown): DelegationTemplate[] {
	if (!Array.isArray(v) || v.length > 6) throw new Error('Harness: hasta 6 plantillas de encargo.');
	const strings = (list: unknown, max: number, size: number, label: string) => {
		if (!Array.isArray(list) || list.length > max || list.some((x) => !bounded(x, size)))
			throw new Error(`Harness: ${label} del encargo inválidas (hasta ${max} de ${size} caracteres).`);
		return list.map((x) => (x as string).trim());
	};
	const list = v.map((t) => {
		keys(
			t,
			['name', 'description', 'objective', 'intro', 'rules', 'collect', 'escalate', 'files', 'maxMessages', 'maxHours'],
			'plantilla de encargo',
		);
		if (typeof t.files !== 'boolean')
			throw new Error(`Harness: el encargo ${String(t.name)} dice si manda archivos (files).`);
		if (
			typeof t.name !== 'string' ||
			!/^[a-z][a-z0-9-]{0,39}$/.test(t.name) ||
			!bounded(t.description, 300) ||
			!bounded(t.objective, 2000) ||
			!bounded(t.intro, 500)
		)
			throw new Error(
				'Harness: plantilla de encargo inválida (nombre slug, descripción hasta 300, objetivo hasta 2000 y presentación hasta 500 caracteres).',
			);
		const c = t.collect;
		keys(c, ['list', 'fields'], 'datos del encargo');
		if (typeof c.list !== 'boolean' || !Array.isArray(c.fields) || !c.fields.length || c.fields.length > 12)
			throw new Error(`Harness: el encargo ${t.name} obtiene de 1 a 12 datos.`);
		const fields = c.fields.map((f) => {
			keys(f, ['name', 'description', 'type'], 'dato del encargo');
			if (
				typeof f.name !== 'string' ||
				!/^[a-z][a-z0-9_]{0,30}$/.test(f.name) ||
				!bounded(f.description, 200) ||
				!['text', 'number', 'boolean'].includes(f.type as string)
			)
				throw new Error(
					`Harness: dato inválido en el encargo ${t.name} (nombre en minúsculas con _, descripción hasta 200, tipo text, number o boolean).`,
				);
			return { name: f.name, description: f.description.trim(), type: f.type as DelegationField['type'] };
		});
		if (new Set(fields.map((f) => f.name)).size !== fields.length)
			throw new Error(`Harness: datos repetidos en el encargo ${t.name}.`);
		if (
			(t.maxMessages !== null &&
				(!Number.isInteger(t.maxMessages) || (t.maxMessages as number) < 1 || (t.maxMessages as number) > 40)) ||
			!Number.isInteger(t.maxHours) ||
			(t.maxHours as number) < 1 ||
			(t.maxHours as number) > 168
		)
			throw new Error(`Harness: el encargo ${t.name} manda de 1 a 40 mensajes (o sin límite) y dura de 1 a 168 horas.`);
		return {
			name: t.name,
			description: t.description.trim(),
			objective: t.objective.trim(),
			intro: t.intro.trim(),
			rules: strings(t.rules, 8, 500, 'reglas'),
			collect: { list: c.list, fields },
			escalate: strings(t.escalate, 6, 300, 'escalaciones'),
			files: t.files,
			maxMessages: t.maxMessages === null ? null : (t.maxMessages as number),
			maxHours: t.maxHours as number,
		};
	});
	if (new Set(list.map((t) => t.name)).size !== list.length)
		throw new Error('Harness: plantillas de encargo repetidas.');
	return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const fieldsOf = (v: unknown, label: string): { list: boolean; fields: DelegationField[] } => {
	keys(v, ['list', 'fields'], label);
	if (typeof v.list !== 'boolean' || !Array.isArray(v.fields) || !v.fields.length || v.fields.length > 12)
		throw new Error(`Harness: ${label} lleva de 1 a 12 datos.`);
	const fields = v.fields.map((f) => {
		keys(f, ['name', 'description', 'type'], label);
		if (
			typeof f.name !== 'string' ||
			!/^[a-z][a-z0-9_]{0,30}$/.test(f.name) ||
			!bounded(f.description, 200) ||
			!['text', 'number', 'boolean'].includes(f.type as string)
		)
			throw new Error(
				`Harness: dato inválido en ${label} (nombre en minúsculas con _, descripción hasta 200, tipo text, number o boolean).`,
			);
		return { name: f.name, description: f.description.trim(), type: f.type as DelegationField['type'] };
	});
	if (new Set(fields.map((f) => f.name)).size !== fields.length)
		throw new Error(`Harness: datos repetidos en ${label}.`);
	return { list: v.list, fields };
};
/** The {parameters} a recipe names, in order of appearance (its objective, steps and encargo values). */
export function flowParams(r: Pick<FlowRecipe, 'objective' | 'steps'>) {
	const names: string[] = [];
	const texts = [
		r.objective,
		...r.steps.flatMap((s) => [s.instructions, ...(s.delegation?.params.map((p) => p.value) ?? [])]),
	];
	for (const text of texts)
		for (const m of text.matchAll(/\{([a-z][a-z0-9_]{0,30})\}/g)) if (!names.includes(m[1])) names.push(m[1]);
	return names;
}
function validateFlows(v: unknown, tools: readonly string[], templates: DelegationTemplate[]): FlowRecipe[] {
	if (!Array.isArray(v) || v.length > 6) throw new Error('Harness: hasta 6 recetas de flujo.');
	const list = v.map((r) => {
		keys(
			r,
			['name', 'description', 'objective', 'produces', 'steps', 'maxHours', 'maxDelegations', 'maxWakes'],
			'receta de flujo',
		);
		if (
			typeof r.name !== 'string' ||
			!/^[a-z][a-z0-9-]{0,39}$/.test(r.name) ||
			!bounded(r.description, 300) ||
			!bounded(r.objective, 2000)
		)
			throw new Error(
				'Harness: receta de flujo inválida (nombre slug, descripción hasta 300 y objetivo hasta 2000 caracteres).',
			);
		const produces = fieldsOf(r.produces, `lo que produce el flujo ${r.name}`);
		if (!Array.isArray(r.steps) || !r.steps.length || r.steps.length > 12)
			throw new Error(`Harness: la receta ${r.name} lleva de 1 a 12 tareas.`);
		const seen: string[] = [];
		const steps = r.steps.map((st) => {
			keys(
				st,
				['key', 'title', 'kind', 'depends', 'instructions', 'optional', 'hours', 'delegation'],
				`paso del flujo ${r.name}`,
			);
			const step = checkStep(st, seen, tools, templates, `el flujo ${r.name}`);
			seen.push(step.key);
			return step;
		});
		const count = steps.filter((x) => x.kind === 'delegation').length;
		for (const [field, min, max] of [
			['maxHours', 1, 336],
			['maxDelegations', 0, 10],
			['maxWakes', 1, 30],
		] as const)
			if (!Number.isInteger(r[field]) || (r[field] as number) < min || (r[field] as number) > max)
				throw new Error(`Harness: ${field} del flujo ${r.name} va de ${min} a ${max}.`);
		if (count > (r.maxDelegations as number))
			throw new Error(`Harness: el flujo ${r.name} tiene ${count} encargos y su tope (maxDelegations) es menor.`);
		return {
			name: r.name,
			description: r.description.trim(),
			objective: r.objective.trim(),
			produces,
			steps,
			maxHours: r.maxHours as number,
			maxDelegations: r.maxDelegations as number,
			maxWakes: r.maxWakes as number,
		};
	});
	if (new Set(list.map((r) => r.name)).size !== list.length) throw new Error('Harness: recetas de flujo repetidas.');
	return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/**
 * One step, of a recipe or of a running flow's plan: its dependencies are earlier steps (so a plan is never
 * a cycle), and what it uses is what the contract allows.
 */
export function checkStep(
	st: Record<string, unknown>,
	before: string[],
	tools: readonly string[],
	templates: DelegationTemplate[],
	where: string,
): RecipeStep {
	if (typeof st.key !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(st.key) || !bounded(st.title, 120))
		throw new Error(`Harness: paso inválido en ${where} (clave slug y título hasta 120 caracteres).`);
	if (before.includes(st.key)) throw new Error(`Harness: el paso ${st.key} está repetido en ${where}.`);
	if (!FLOW_STEP_KINDS.includes(st.kind as FlowStepKind))
		throw new Error(`Harness: el paso ${st.key} es agent, subagent, delegation, question o wait.`);
	const kind = st.kind as FlowStepKind;
	if (
		!Array.isArray(st.depends) ||
		st.depends.length > 10 ||
		st.depends.some((d) => typeof d !== 'string' || !before.includes(d))
	)
		throw new Error(`Harness: el paso ${st.key} sólo depende de pasos anteriores a él en ${where}.`);
	if (typeof st.instructions !== 'string' || st.instructions.length > 1000)
		throw new Error(`Harness: las instrucciones del paso ${st.key} van hasta 1000 caracteres.`);
	if (kind !== 'delegation' && kind !== 'wait' && !st.instructions.trim())
		throw new Error(`Harness: el paso ${st.key} necesita instrucciones.`);
	if (typeof st.optional !== 'boolean') throw new Error(`Harness: el paso ${st.key} dice si es opcional.`);
	if (kind === 'subagent' && !tools.includes('subagents'))
		throw new Error(`Harness: el paso ${st.key} usa subagentes y el agente no tiene la herramienta subagents.`);
	let hours: number | null = null;
	if (kind === 'wait') {
		if (!Number.isInteger(st.hours) || (st.hours as number) < 1 || (st.hours as number) > 168)
			throw new Error(`Harness: la espera ${st.key} dura de 1 a 168 horas.`);
		hours = st.hours as number;
	} else if (st.hours !== null) throw new Error(`Harness: sólo una espera lleva horas (paso ${st.key}).`);
	let delegation: RecipeStep['delegation'] = null;
	if (kind === 'delegation') {
		const d = st.delegation;
		keys(d, ['template', 'contact', 'params'], `encargo del paso ${st.key}`);
		if (!tools.includes('delegations') || !templates.some((t) => t.name === d.template))
			throw new Error(`Harness: el paso ${st.key} usa una plantilla de encargo que el contrato no tiene.`);
		if (typeof d.contact !== 'string' || d.contact.length > 80)
			throw new Error(`Harness: el contacto del paso ${st.key} va hasta 80 caracteres (vacío: lo elige el agente).`);
		delegation = {
			template: d.template as string,
			contact: d.contact.trim(),
			params: pairs(d.params, 'parámetros del encargo'),
		};
	} else if (st.delegation !== null)
		throw new Error(`Harness: sólo un paso delegation lleva encargo (paso ${st.key}).`);
	return {
		key: st.key,
		title: st.title.trim(),
		kind,
		depends: st.depends as string[],
		instructions: st.instructions.trim(),
		optional: st.optional,
		hours,
		delegation,
	};
}
export function validateHarness(value: unknown): Harness {
	if (object(value)) {
		const { mcp: _m, installs: _i, delegations: _d, flows: _f, rubric: _r, ...base } = value;
		keys(base, ['version', 'tools', 'restrictions', 'skills', 'plugins'], 'manifiesto');
	}
	keys(value, Object.keys(value as object), 'manifiesto');
	if (value.version !== HARNESS_VERSION) throw new Error('Versión de harness no admitida.');
	const tools = value.tools;
	if (
		!Array.isArray(tools) ||
		tools.length > TOOLS.length ||
		tools.some((t) => !TOOLS.some((x) => x.id === t)) ||
		new Set(tools).size !== tools.length ||
		!tools.includes('request_help')
	)
		throw new Error('Harness: elige herramientas del catálogo, sin duplicados, e incluye request_help.');
	const r = value.restrictions;
	keys(r, ['workspaceFilesOnly', 'readOnlyFiles', 'guidelines'], 'restricciones');
	if (
		typeof r.workspaceFilesOnly !== 'boolean' ||
		typeof r.readOnlyFiles !== 'boolean' ||
		!Array.isArray(r.guidelines) ||
		r.guidelines.length > 8 ||
		r.guidelines.some((g) => !bounded(g, 500))
	)
		throw new Error('Harness: restricciones inválidas (hasta 8 pautas de 500 caracteres).');
	if ((r.workspaceFilesOnly || r.readOnlyFiles) && tools.includes('bash'))
		throw new Error('Harness: desactiva bash para restringir archivos; la shell eludiría esos controles.');
	if (r.readOnlyFiles && (tools.includes('write') || tools.includes('edit')))
		throw new Error('Harness: lectura sola no admite write ni edit.');
	if (!Array.isArray(value.skills) || value.skills.length > 4) throw new Error('Harness: máximo cuatro skills.');
	const skills = value.skills
		.map((s) => {
			keys(s, ['name', 'description', 'instructions'], 'skill');
			if (
				typeof s.name !== 'string' ||
				!/^[a-z][a-z0-9-]{0,39}$/.test(s.name) ||
				!bounded(s.description, 300) ||
				!bounded(s.instructions, 8000)
			)
				throw new Error(
					'Harness: skill inválida (nombre slug, descripción hasta 300 e instrucciones hasta 8000 caracteres).',
				);
			return { name: s.name, description: s.description.trim(), instructions: s.instructions.trim() };
		})
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (
		new Set(skills.map((s) => s.name)).size !== skills.length ||
		skills.reduce((n, s) => n + s.instructions.length, 0) > 16000
	)
		throw new Error('Harness: skills duplicadas o más de 16000 caracteres de instrucciones.');
	if (!Array.isArray(value.plugins) || value.plugins.length > PLUGINS.length)
		throw new Error('Harness: plugins fuera del catálogo.');
	const plugins = value.plugins
		.map((p) => {
			keys(p, ['id', 'version'], 'plugin');
			if (!PLUGINS.some((c) => c.id === p.id && c.version === p.version))
				throw new Error(
					'Harness: sólo plugins de catálogo con versión exacta. Código generado y paquetes externos no están habilitados.',
				);
			return { id: p.id, version: p.version } as Harness['plugins'][number];
		})
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (new Set(plugins.map((p) => p.id)).size !== plugins.length) throw new Error('Harness: plugin duplicado.');
	const mcp = value.mcp === undefined ? [] : validateMcp(value.mcp),
		installs = value.installs === undefined ? [] : validateInstalls(value.installs),
		delegations = value.delegations === undefined ? [] : validateDelegations(value.delegations);
	if (tools.includes('delegations') && !delegations.length)
		throw new Error('Harness: la herramienta delegations necesita al menos una plantilla en delegations.');
	const flows = value.flows === undefined ? [] : validateFlows(value.flows, tools as string[], delegations);
	if (tools.includes('flows') && !flows.length)
		throw new Error('Harness: la herramienta flows necesita al menos una receta en flows.');
	const rubric = value.rubric === undefined ? [] : validateRubric(value.rubric);
	if (mcp.some((s) => s.transport === 'stdio') && !tools.includes('bash'))
		throw new Error(
			'Harness: un MCP local corre un comando en la computadora; requiere bash habilitado (su selección no es una frontera de seguridad).',
		);
	return {
		version: 1,
		tools: [...tools].sort(),
		restrictions: {
			workspaceFilesOnly: r.workspaceFilesOnly,
			readOnlyFiles: r.readOnlyFiles,
			guidelines: r.guidelines.map((g) => (g as string).trim()),
		},
		skills,
		plugins,
		...(mcp.length ? { mcp } : {}),
		...(installs.length ? { installs } : {}),
		...(delegations.length ? { delegations } : {}),
		...(flows.length ? { flows } : {}),
		...(rubric.length ? { rubric } : {}),
	};
}
/** The owner's weights: criteria of the rubric, 0 to 5 each; one equal to the default is not kept. */
function validateRubric(v: unknown): NonNullable<Harness['rubric']> {
	if (!Array.isArray(v) || v.length > RUBRIC.length)
		throw new Error('Harness: la rúbrica tiene sus criterios, una vez cada uno.');
	const out = v.map((x) => {
		keys(x, ['key', 'weight'], 'criterio de la rúbrica');
		const c = RUBRIC.find((r) => r.key === x.key);
		if (!c || !Number.isInteger(x.weight) || (x.weight as number) < 0 || (x.weight as number) > 5)
			throw new Error(
				`Harness: criterio de la rúbrica inválido (${String(x.key)}): uno de los de la plataforma, con peso de 0 a 5.`,
			);
		return { key: c.key as RubricKey, weight: x.weight as number };
	});
	if (new Set(out.map((x) => x.key)).size !== out.length)
		throw new Error('Harness: criterios repetidos en la rúbrica.');
	return out
		.filter((x) => RUBRIC.find((r) => r.key === x.key)!.weight !== x.weight)
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** Each criterion with the weight this contract gives it. */
export function rubricOf(h: Pick<Harness, 'rubric'>) {
	return RUBRIC.map((c) => ({ ...c, weight: h.rubric?.find((x) => x.key === c.key)?.weight ?? c.weight }));
}
/** The prefix of an approved MCP server's tools, as pi names them (mcp__<server>__<tool>). */
export const mcpPrefix = (server: string) => `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__`;
/** An MCP tool of an approved server, or of one granted to the agent (the person's own, #24). */
export const mcpAllowed = (h: Harness, tool: string, granted: readonly string[] = []) =>
	[...(h.mcp ?? []).map((s) => s.name), ...granted].some((name) => tool.startsWith(mcpPrefix(name)));
export function effectiveTools(h: Harness) {
	return [
		...h.tools.map((id) => TOOLS.find((t) => t.id === id)!),
		...h.plugins.flatMap((p) => {
			const c = PLUGINS.find((x) => x.id === p.id)!;
			return c.tools.map((id) => ({ id, name: id, description: `${c.name} · ${c.version}. ${c.description}` }));
		}),
	];
}
/** The tools pi registers for one catalog entry, when they are not named after it. */
const RUNTIME_NAMES: Partial<Record<string, string[]>> = {
	delegations: ['delegation_cancel', 'delegation_message', 'delegation_start', 'delegation_status'],
	// The task tools are the platform's (every main agent has them); recipes only preload a list.
	flows: [],
};
export function runtimeToolNames(h: Harness) {
	return effectiveTools(h)
		.flatMap((t) => RUNTIME_NAMES[t.id] ?? [t.id])
		.sort();
}
export function harnessInstructions(h: Harness) {
	const shell = h.tools.includes('bash');
	const navigation = h.tools.includes('browser')
		? 'Usa browser para navegar.'
		: shell
			? 'Para navegar usa agent-browser mediante bash, en la sesión visible.'
			: 'No hay navegador disponible; pide ayuda si la tarea necesita navegar.';
	const autonomy = shell
		? 'La shell está habilitada: puedes crear, ejecutar y conservar scripts propios (Python, JavaScript o shell), procesar archivos y añadir dependencias locales con uv o bun (la computadora corre con Bun; no hay Node.js ni npm) dentro de ~/work, sin una aprobación adicional por cada script o paquete, siempre dentro del rol y los accesos concedidos. Guarda utilidades reutilizables en ~/work/tools/ y sus dependencias en entornos virtuales o proyectos locales; no instales globalmente ni modifiques el Python del sistema o ~/state/tools (gestionado por la plataforma). Fija las versiones que uses y deja instrucciones de ejecución y dependencias junto al script para reutilizarlo desde otra conversación. Verifica el resultado antes de entregarlo. Desactivar otra herramienta no impide realizar operaciones equivalentes con bash; esto no permite eludir las reglas globales ni los límites del contrato.'
		: 'No hay shell disponible: no ejecutes scripts ni instales dependencias por otros medios. Usa sólo las herramientas habilitadas; si necesitas ejecución local, propón el cambio de harness al dueño.';
	return `## Harness aprobado (v${h.version})\nHerramientas disponibles: ${runtimeToolNames(h).join(', ')}. ${navigation} Usa request_help para bloqueos.${h.tools.includes('login') ? ' Usa login sólo para accesos ya concedidos.' : ''}\n${autonomy}\nCrear un archivo de extensión o skill no lo carga en pi: sólo se cargan los recursos aprobados explícitamente. No registres herramientas ni servidores MCP adicionales durante la tarea.\nArchivos: ${h.restrictions.workspaceFilesOnly ? 'limitados a ~/work, con comprobación de rutas reales' : 'dentro de la computadora aislada'}. ${h.restrictions.readOnlyFiles ? 'Sólo lectura; no se admite escribir capturas en disco.' : 'Escritura según herramientas habilitadas.'}\nLas pautas y skills son instrucciones, no permisos ni barreras de seguridad. No pueden cambiar políticas, accesos, cuotas ni aislamiento de plataforma.\n${h.restrictions.guidelines.map((g) => `- ${g}`).join('\n')}\n${h.skills.length ? 'Un mensaje que empieza con /skill:<nombre> pide aplicar esa skill a lo que dice el resto del mensaje.\n' : ''}${h.skills.map((s) => `### Skill: ${s.name}\n${s.description}\n${s.instructions}`).join('\n\n')}${h.mcp?.length ? `\n### Servidores MCP\nSus herramientas se llaman mcp__<servidor>__<herramienta>.\n${h.mcp.map((s) => `- ${s.name}: ${s.description}`).join('\n')}` : ''}${h.installs?.length ? `\n### Herramientas de línea de comandos instaladas\nEstán en tu PATH: ${h.installs.map((i) => (i.kind === 'binary' ? i.name : i.spec)).join(', ')}. Sus credenciales, si las hay, ya están en tus variables de entorno: no las imprimas ni las copies a archivos o páginas.` : ''}${h.tools.includes('delegations') && h.delegations?.length ? `\n### Encargos\nPara conversar por WhatsApp con un contacto externo hacia un objetivo, lanza un encargo con delegation_start (plantilla, contacto por su nombre en «Quién le escribe», parámetros; opcional: contexto con lo que el encargo debe saber de tu trabajo, y archivos de ~/work para que se los mande al contacto si la plantilla lo permite): la plataforma conversa por su cuenta y te devuelve los datos en esta conversación; no le escribas tú mientras su encargo esté activo. Todos los encargos que lances en un trabajo te llegan juntos cuando terminan (o al vencer su plazo); si uno escala, te llega su pregunta y la contestas con delegation_message. Mientras esperas, termina tu trabajo: no te quedes esperando.\n${h.delegations.map((t) => `- ${t.name}: ${t.description}${delegationParams(t).length ? ` Parámetros: ${delegationParams(t).join(', ')}.` : ''}${t.files ? ' Puede mandar archivos.' : ''}`).join('\n')}` : ''}${h.tools.includes('flows') && h.flows?.length ? `\n### Recetas\nUna receta es una lista de tareas ya escrita para un trabajo de varios pasos que dura horas o días: la arrancas con task_plan (receta y parámetros) cuando tu contrato lo dice, y la plataforma lleva sus tareas, lanza sus encargos, le pregunta lo que haga falta al dueño y te despierta en ese trabajo cuando una tarea es tuya o hay algo que decidir. Cuando todas terminaron, entrega su resultado con task_update sin tarea, en la forma de la receta.\n${h.flows.map((r) => `- ${r.name}: ${r.description}${flowParams(r).length ? ` Parámetros: ${flowParams(r).join(', ')}.` : ''} Tareas: ${r.steps.map((x) => `${x.key} (${x.kind})`).join(', ')}.`).join('\n')}` : ''}`;
}
// Responses API strict schema: every property is required, optional proposal = null.
const PAIRS = {
	type: 'array',
	items: {
		type: 'object',
		additionalProperties: false,
		required: ['name', 'value'],
		properties: { name: { type: 'string' }, value: { type: 'string' } },
	},
};
export const HARNESS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [
		'version',
		'tools',
		'restrictions',
		'skills',
		'plugins',
		'mcp',
		'installs',
		'delegations',
		'flows',
		'rubric',
	],
	properties: {
		rubric: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['key', 'weight'],
				properties: { key: { type: 'string', enum: RUBRIC.map((r) => r.key) }, weight: { type: 'integer' } },
			},
		},
		flows: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'description', 'objective', 'produces', 'steps', 'maxHours', 'maxDelegations', 'maxWakes'],
				properties: {
					name: { type: 'string' },
					description: { type: 'string' },
					objective: { type: 'string' },
					produces: {
						type: 'object',
						additionalProperties: false,
						required: ['list', 'fields'],
						properties: {
							list: { type: 'boolean' },
							fields: {
								type: 'array',
								items: {
									type: 'object',
									additionalProperties: false,
									required: ['name', 'description', 'type'],
									properties: {
										name: { type: 'string' },
										description: { type: 'string' },
										type: { type: 'string', enum: ['text', 'number', 'boolean'] },
									},
								},
							},
						},
					},
					steps: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['key', 'title', 'kind', 'depends', 'instructions', 'optional', 'hours', 'delegation'],
							properties: {
								key: { type: 'string' },
								title: { type: 'string' },
								kind: { type: 'string', enum: [...FLOW_STEP_KINDS] },
								depends: { type: 'array', items: { type: 'string' } },
								instructions: { type: 'string' },
								optional: { type: 'boolean' },
								hours: { type: ['integer', 'null'] },
								delegation: {
									anyOf: [
										{ type: 'null' },
										{
											type: 'object',
											additionalProperties: false,
											required: ['template', 'contact', 'params'],
											properties: { template: { type: 'string' }, contact: { type: 'string' }, params: PAIRS },
										},
									],
								},
							},
						},
					},
					maxHours: { type: 'integer' },
					maxDelegations: { type: 'integer' },
					maxWakes: { type: 'integer' },
				},
			},
		},
		delegations: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: [
					'name',
					'description',
					'objective',
					'intro',
					'rules',
					'collect',
					'escalate',
					'files',
					'maxMessages',
					'maxHours',
				],
				properties: {
					name: { type: 'string' },
					description: { type: 'string' },
					objective: { type: 'string' },
					intro: { type: 'string' },
					rules: { type: 'array', items: { type: 'string' } },
					collect: {
						type: 'object',
						additionalProperties: false,
						required: ['list', 'fields'],
						properties: {
							list: { type: 'boolean' },
							fields: {
								type: 'array',
								items: {
									type: 'object',
									additionalProperties: false,
									required: ['name', 'description', 'type'],
									properties: {
										name: { type: 'string' },
										description: { type: 'string' },
										type: { type: 'string', enum: ['text', 'number', 'boolean'] },
									},
								},
							},
						},
					},
					escalate: { type: 'array', items: { type: 'string' } },
					files: { type: 'boolean' },
					maxMessages: { type: ['integer', 'null'] },
					maxHours: { type: 'integer' },
				},
			},
		},
		mcp: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'description', 'transport', 'url', 'command', 'args', 'headers', 'env', 'oauth'],
				properties: {
					name: { type: 'string' },
					description: { type: 'string' },
					transport: { type: 'string', enum: ['http', 'stdio'] },
					url: { type: ['string', 'null'] },
					command: { type: ['string', 'null'] },
					args: { type: 'array', items: { type: 'string' } },
					headers: PAIRS,
					env: PAIRS,
					oauth: { type: 'boolean' },
				},
			},
		},
		installs: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['kind', 'spec', 'name', 'sha256'],
				properties: {
					kind: { type: 'string', enum: ['npm', 'uv', 'binary'] },
					spec: { type: 'string' },
					name: { type: ['string', 'null'] },
					sha256: { type: ['string', 'null'] },
				},
			},
		},
		version: { type: 'integer', enum: [1] },
		tools: { type: 'array', items: { type: 'string', enum: TOOLS.map((t) => t.id) } },
		restrictions: {
			type: 'object',
			additionalProperties: false,
			required: ['workspaceFilesOnly', 'readOnlyFiles', 'guidelines'],
			properties: {
				workspaceFilesOnly: { type: 'boolean' },
				readOnlyFiles: { type: 'boolean' },
				guidelines: { type: 'array', items: { type: 'string' } },
			},
		},
		skills: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'description', 'instructions'],
				properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } },
			},
		},
		plugins: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'version'],
				properties: {
					id: { type: 'string', enum: PLUGINS.map((p) => p.id) },
					version: { type: 'string', enum: ['1.0.0'] },
				},
			},
		},
	},
};
