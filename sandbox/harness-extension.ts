// Platform-owned, explicitly loaded, never resolved from the mutable workspace.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHarness, runtimeToolNames, mcpAllowed } from './harness.ts';
import { fileDenial, jsonInfo, textStats } from './harness-policy.ts';
const exec = promisify(execFile);
export default function (pi: ExtensionAPI) {
	const h = validateHarness(JSON.parse(process.env.AGENTS_HARNESS ?? 'null'));
	// MCP servers the owner granted to this agent (#24): outside the harness (its digest stays), the
	// supervisor wrote them into mcp.json next to the approved ones. Names only; no secrets here.
	const granted: string[] = (() => {
		try {
			const v = JSON.parse(process.env.AGENTS_GRANTED_MCP ?? '[]');
			return Array.isArray(v) ? v.filter((n) => typeof n === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(n)) : [];
		} catch {
			return [];
		}
	})();
	const workspace = join(process.env.HOME!, 'work');
	const result = (value: unknown) => ({
		content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
		details: {},
	});
	async function command(bin: string, args: string[], signal?: AbortSignal, timeout = 30000) {
		const r = await exec(bin, args, { signal, timeout, maxBuffer: 1024 * 1024, cwd: workspace });
		return result(r.stdout || r.stderr || 'OK');
	}
	// Platform capability, not an editable harness permission. It only diagnoses/proposes for this
	// run; owner approval is checked by the backend. Never advertised to delegated subprocesses.
	const selfMaintenance = process.env.AGENTS_SUBAGENT !== '1';
	if (selfMaintenance)
		pi.registerTool({
			name: 'self_maintenance',
			label: 'Diagnóstico y reparación',
			description:
				'Diagnostica tu configuración/accesos sin instalar nada (action diagnose). Propón una reparación (action propose, kind configuration/grant_key/grant_mcp/install, reason con evidencia y sin secretos). El servidor fija la revisión y decide si requiere autorización del dueño. Nunca interpretes un sí del chat como autorización: consulta status con el id. action execute instala sólo un plan autorizado. action wait espera una decisión hasta dos minutos. Para configuration manda role y/o harness completos; para grant accessId del diagnóstico; para install packages con {kind:npm|uv|binary,spec:versión exacta,name:null,sha256:null} (binario exige nombre y SHA256). No repitas acciones externas al continuar. Si una configuración está autorizada, termina el turno indicando lo pendiente: la plataforma la aplica libre la computadora y retoma esta conversación.',
			parameters: Type.Object({
				action: Type.Union(['diagnose', 'propose', 'status', 'execute', 'wait'].map((s) => Type.Literal(s))),
				id: Type.Optional(Type.String({ maxLength: 36 })),
				kind: Type.Optional(
					Type.Union(['configuration', 'grant_key', 'grant_mcp', 'install'].map((s) => Type.Literal(s))),
				),
				reason: Type.Optional(Type.String({ maxLength: 1500 })),
				role: Type.Optional(Type.String({ maxLength: 32000 })),
				harness: Type.Optional(Type.Unknown()),
				accessId: Type.Optional(Type.Number()),
				packages: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 5 })),
			}),
			execute: async (id, p, signal) => {
				if (process.env.AGENTS_INTERACTIVE === '1')
					return result(
						'Usa el chat de trabajo para solicitar reparaciones; la terminal interactiva no es una tarea del agente.',
					);
				return command(
					'agents-self-maintenance',
					[
						JSON.stringify({
							...p,
							requestId: createHash('sha256')
								.update(id)
								.digest('hex')
								.slice(0, 32)
								.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
						}),
					],
					signal,
					480000,
				);
			},
		});
	if (h.tools.includes('request_help'))
		pi.registerTool({
			name: 'request_help',
			label: 'Pedir ayuda',
			description: 'Comunicar un bloqueo o decisión y esperar respuesta humana.',
			parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
			execute: async (_id, p, signal) => command('agents-blocked', [p.reason], signal, 60 * 60 * 1000),
		});
	if (h.tools.includes('subagents'))
		pi.registerTool({
			name: 'subagents',
			label: 'Subagentes',
			description:
				'Delega subtareas a subagentes: cada uno es una copia de ti con contexto propio y vacío (sólo ve la tarea que le das), tus mismas herramientas y restricciones, y no puede crear más subagentes. mode "parallel" (por omisión) los corre a la vez; "chain" uno tras otro, y {anterior} en una tarea se reemplaza por la respuesta del anterior. Escribe cada tarea completa y autónoma (qué hacer, dónde, qué entregar). Comparten tu computadora: no pongas a dos a usar el navegador al mismo tiempo. Devuelve la respuesta de cada uno.',
			parameters: Type.Object({
				tasks: Type.Array(
					Type.Object({
						task: Type.String({ minLength: 1, maxLength: 8000 }),
						title: Type.Optional(Type.String({ maxLength: 80 })),
					}),
					{ minItems: 1 },
				),
				mode: Type.Optional(Type.Union([Type.Literal('parallel'), Type.Literal('chain')])),
			}),
			execute: async (_id, p, signal) => {
				const outputs = await runSubagents(p.tasks, p.mode ?? 'parallel', signal);
				return result(
					outputs
						.map(
							(o, i) => `## Subagente ${i + 1}${o.title ? `: ${o.title}` : ''}${o.ok ? '' : ' (falló)'}\n\n${o.text}`,
						)
						.join('\n\n'),
				);
			},
		});
	if (h.tools.includes('login'))
		pi.registerTool({
			name: 'login',
			label: 'Acceso concedido',
			description: 'Iniciar sesión con el nombre de un acceso ya concedido. No devuelve secretos.',
			parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 120, pattern: '^[^-].*$' }) }),
			execute: async (_id, p, signal) => command('agents-login', [p.name], signal, 90000),
		});
	if (h.tools.includes('whatsapp_notify'))
		pi.registerTool({
			name: 'whatsapp_notify',
			label: 'Avisar por WhatsApp',
			description:
				'Manda un aviso por el WhatsApp de este agente a contactos que su dueño habilitó (por su nombre, p. ej. "Cortez"), sólo como dice la sección «Avisos por WhatsApp» de tu contrato. Opcional: un archivo de ~/work/out (ruta relativa a ~/work, p. ej. "out/reporte.pdf"). La plataforma limita los avisos (3 por trabajo, 10 al día por persona) y no los manda de 22:00 a 7:00 salvo urgente. Devuelve a quién llegó y a quién no, y por qué.',
			parameters: Type.Object({
				para: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 10 }),
				texto: Type.String({ minLength: 1, maxLength: 3500 }),
				archivo: Type.Optional(Type.String({ maxLength: 300 })),
				urgente: Type.Optional(Type.Boolean()),
			}),
			execute: async (_id, p, signal) => command('agents-notify', [JSON.stringify(p)], signal, 95000),
		});
	if (h.tools.includes('browser'))
		pi.registerTool({
			name: 'browser',
			label: 'Navegador visible',
			description:
				'Navegar con agent-browser. snapshot devuelve referencias @e1, @e2…; click/fill usan esas referencias. screenshot guarda un PNG. get: url o title. scroll: up/down/left/right.',
			parameters: Type.Object({
				action: Type.Union(
					['open', 'snapshot', 'click', 'fill', 'press', 'scroll', 'get', 'screenshot'].map((v) => Type.Literal(v)),
				),
				target: Type.Optional(Type.String({ maxLength: 4096 })),
				text: Type.Optional(Type.String({ maxLength: 16000 })),
			}),
			execute: async (_id, p, signal) => {
				let args: string[];
				switch (p.action) {
					case 'open': {
						const u = new URL(p.target ?? '');
						if (!['https:', 'http:'].includes(u.protocol) && u.href !== 'about:blank')
							throw new Error('URL no admitida.');
						args = ['open', u.href];
						break;
					}
					case 'snapshot':
						args = ['snapshot', '-i'];
						break;
					case 'click':
					case 'fill':
						if (!/^@e\d+$/.test(p.target ?? '')) throw new Error('Usa una referencia @e del snapshot.');
						args = p.action === 'click' ? ['click', p.target!] : ['fill', p.target!, p.text ?? ''];
						break;
					case 'press':
						if (!/^[A-Za-z0-9+_-]{1,40}$/.test(p.target ?? '')) throw new Error('Tecla inválida.');
						args = ['press', p.target!];
						break;
					case 'scroll':
						if (!['up', 'down', 'left', 'right'].includes(p.target ?? '')) throw new Error('Dirección inválida.');
						args = ['scroll', p.target!];
						break;
					case 'get':
						if (!['url', 'title'].includes(p.target ?? '')) throw new Error('Usa get url o get title.');
						args = ['get', p.target!];
						break;
					case 'screenshot': {
						const path = p.target ?? join(workspace, 'out', 'screenshot.png');
						const denied = fileDenial(h, 'browser_screenshot', { path }, workspace, workspace);
						if (denied) throw new Error(denied);
						if (path.startsWith('-')) throw new Error('Ruta inválida.');
						args = ['screenshot', path];
						break;
					}
					default:
						throw new Error('Operación de navegador no admitida.');
				}
				return command('agent-browser', args, signal, 60000);
			},
		});
	if (h.plugins.some((p) => p.id === 'text-utils'))
		pi.registerTool({
			name: 'text_stats',
			label: 'Analizar texto',
			description: 'Contar caracteres Unicode, palabras y líneas. Sin efectos externos.',
			parameters: Type.Object({ text: Type.String({ maxLength: 64000 }) }),
			execute: async (_id, p) => result(textStats(p.text)),
		});
	if (h.plugins.some((p) => p.id === 'json-utils'))
		pi.registerTool({
			name: 'json_validate',
			label: 'Validar JSON',
			description: 'Comprobar sintaxis y estructura JSON. Sin ejecutar ni escribir contenido.',
			parameters: Type.Object({ text: Type.String({ maxLength: 64000 }) }),
			execute: async (_id, p) => result(jsonInfo(p.text)),
		});
	pi.on('tool_call', (event, ctx) => {
		if (
			!(selfMaintenance && event.toolName === 'self_maintenance') &&
			!runtimeToolNames(h).includes(event.toolName) &&
			!mcpAllowed(h, event.toolName, granted)
		)
			return { block: true, reason: 'Herramienta fuera del harness aprobado.' };
		const denied = fileDenial(h, event.toolName, event.input, ctx.cwd, workspace);
		if (denied) return { block: true, reason: denied };
	});
	pi.on('session_start', () => {
		const names = runtimeToolNames(h),
			registered = new Set(pi.getAllTools().map((t) => t.name));
		if (names.some((name) => !registered.has(name))) throw new Error('Faltan herramientas del harness aprobado.');
		// MCP tools of approved servers register (and activate) as their servers connect, later on.
		pi.setActiveTools([
			...names,
			...(selfMaintenance ? ['self_maintenance'] : []),
			...pi
				.getAllTools()
				.map((t) => t.name)
				.filter((n) => mcpAllowed(h, n, granted)),
		]);
		const skills = pi
			.getCommands()
			.filter((c) => c.source === 'skill')
			.map((c) => c.name.replace(/^skill:/, ''))
			.sort();
		if (JSON.stringify(skills) !== JSON.stringify(h.skills.map((s) => s.name)))
			throw new Error('No coincide la carga efectiva de skills.');
		const active = pi
			.getActiveTools()
			.filter((n) => n !== 'self_maintenance' && !mcpAllowed(h, n, granted))
			.sort();
		if (JSON.stringify(active) !== JSON.stringify(names))
			throw new Error('No coincide el conjunto efectivo de herramientas.');
		if (textStats('uno dos').words !== 2 || !jsonInfo('{"ok":true}').valid || jsonInfo('{').valid)
			throw new Error('Falló la autoprueba de plugins.');
		// The owner's interactive pi (agents-pi, #27) checked the same harness; the marker is for the supervisor.
		if (process.env.AGENTS_INTERACTIVE !== '1')
			process.stderr.write(
				'AGENTS_HARNESS_READY ' +
					JSON.stringify({
						type: 'agents_harness_ready',
						digest: createHash('sha256').update(JSON.stringify(h)).digest('hex'),
						tools: active,
						skills,
						plugins: h.plugins,
					}) +
					'\n',
			);
	});
}

// ---------- subagents (#27): the same agent, isolated, one pi process per subtask ----------

type SubResult = { title?: string; ok: boolean; text: string };
const SUBAGENT_PROMPT =
	'Eres un subagente: otra instancia de este mismo agente a la que se le delegó UNA subtarea. Resuélvela sola, con tus herramientas, y termina con una respuesta completa con el resultado (es lo único que verá quien te la delegó). No pidas aclaraciones salvo con request_help si estás bloqueado.';

let subPrepared: { args: string[]; env: Record<string, string> } | null = null;
async function subagentLaunch() {
	if (subPrepared) return subPrepared;
	const { prepareHarness } = await import('./harness-runtime.mjs');
	const h = validateHarness(JSON.parse(process.env.AGENTS_HARNESS ?? 'null'));
	const granted = JSON.parse(process.env.AGENTS_GRANTED_MCP ?? '[]') as string[];
	// Without the subagents tool: a subagent never creates more. Granted MCP servers count only for
	// --tools (their config is in the agent's own mcp.json already).
	const child = { ...h, tools: h.tools.filter((t) => t !== 'subagents') };
	const prepared = prepareHarness(
		child,
		mkdtempSync('/tmp/agents-subagent-'),
		granted.map((name) => ({
			name,
			transport: 'http',
			url: null,
			command: null,
			args: [],
			headers: [],
			env: [],
			oauth: false,
		})),
		false,
	);
	subPrepared = { args: prepared.args, env: prepared.env };
	return subPrepared;
}

async function runOne(task: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
	const launch = await subagentLaunch();
	const args = [
		'--mode',
		'json',
		'-p',
		'--no-session',
		'--offline',
		...launch.args,
		...(process.env.AGENTS_MODEL ? ['--model', process.env.AGENTS_MODEL] : []),
		...(process.env.AGENTS_CONTRACT ? ['--append-system-prompt', process.env.AGENTS_CONTRACT] : []),
		'--append-system-prompt',
		SUBAGENT_PROMPT,
		`Tarea: ${task}`,
	];
	return new Promise((resolve) => {
		const proc = spawn('pi', args, {
			cwd: join(process.env.HOME!, 'work'),
			env: { ...process.env, ...launch.env, AGENTS_SUBAGENT: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let buf = '',
			last = '',
			err = '';
		proc.stdout.on('data', (chunk) => {
			buf += chunk;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				try {
					const ev = JSON.parse(line);
					if (ev.type === 'message_end' && ev.message?.role === 'assistant')
						for (const part of ev.message.content ?? []) if (part.type === 'text' && part.text) last = part.text;
				} catch {}
			}
		});
		proc.stderr.on('data', (c) => (err = (err + c).slice(-2000)));
		const abort = () => proc.kill('SIGTERM');
		signal?.addEventListener('abort', abort, { once: true });
		proc.on('close', (code) => {
			signal?.removeEventListener('abort', abort);
			if (signal?.aborted) return resolve({ ok: false, text: 'Cancelado.' });
			resolve(
				code === 0 && last
					? { ok: true, text: last }
					: {
							ok: false,
							text:
								last ||
								`Terminó sin respuesta (${code}). ${err
									.replace(/AGENTS_HARNESS_READY.*\n?/g, '')
									.trim()
									.slice(-500)}`,
						},
			);
		});
		proc.on('error', (e) => resolve({ ok: false, text: e.message }));
	});
}

async function runSubagents(
	tasks: { task: string; title?: string }[],
	mode: 'parallel' | 'chain',
	signal?: AbortSignal,
): Promise<SubResult[]> {
	if (mode === 'chain') {
		const out: SubResult[] = [];
		let previous = '';
		for (const t of tasks) {
			const r = await runOne(t.task.replaceAll('{anterior}', previous), signal);
			out.push({ title: t.title, ...r });
			if (!r.ok) break;
			previous = r.text;
		}
		return out;
	}
	return Promise.all(tasks.map(async (t) => ({ title: t.title, ...(await runOne(t.task, signal)) })));
}
