// The model proposes. Only the authenticated owner decides; the server validates and applies.
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { row, rows, exec, tx, type Exec } from './db';
import * as agents from './agents';
import * as accesses from './accesses';
import { digest, validateHarness, harnessHash, saveRevision } from './harnesses';
import { validateContract } from './design-format';
import { runtimeToolNames, type Install } from '../../sandbox/harness';
import {
	installPolicy,
	repairText,
	repairPending,
	type Repair,
	type RepairAction,
	type Diagnosis,
} from '../../shared/self-maintenance';
import { DockerSandbox } from './sandbox/docker';
import { claimHarnessValidation, ImageUpdateWaiting } from './image-updates';
import * as hub from './hub';

type Stored = Repair & {
	definition_digest: string;
	request_id: string;
	request_digest: string;
	continuation_id: number | null;
};
// Fingerprint without validating: a broken stored harness must still be repairable.
const configFingerprint = (a: agents.Agent) =>
	digest({
		revision: a.config_revision,
		name: a.name,
		role: a.role,
		model: a.model,
		harness: a.harness,
		image: a.harness_image,
	});
const uuid = /^[a-f0-9-]{36}$/i;
const activeRun = (id: number, on?: Exec) =>
	row("select 1 from runs where agent_id=$1 and status in ('queued','starting','running','blocked')", [id], on);
async function owner(agentId: number, by: number, on?: Exec) {
	const a = await row<agents.Agent>(
		`select * from agents where id=$1 and person_id=$2 and deleted_at is null${on ? ' for update' : ''}`,
		[agentId, by],
		on,
	);
	if (!a) throw new Error('Sólo el dueño puede diagnosticar o reparar este agente.');
	return a;
}
function harnessForDisplay(raw: agents.Agent['harness']) {
	const h = structuredClone(raw);
	const cleanUrl = (url: string) => {
		try {
			const u = new URL(url);
			u.username = '';
			u.password = '';
			u.search = '';
			u.hash = '';
			return u.href;
		} catch {
			return '[URL inválida — revisar en Accesos]';
		}
	};
	for (const m of Array.isArray(h?.mcp) ? h.mcp : []) {
		if (!m || typeof m !== 'object') continue;
		for (const fields of [m.headers, m.env])
			for (const p of Array.isArray(fields) ? fields : [])
				if (p && typeof p === 'object' && !/^\$\{[A-Z][A-Z0-9_]{1,63}\}$/.test(p.value))
					p.value = '[oculto — revisar en Accesos]';
		if (Array.isArray(m.args)) m.args = m.args.map(() => '[argumento oculto]');
		if (m.url) m.url = cleanUrl(m.url);
	}
	for (const p of Array.isArray(h?.installs) ? h.installs : []) if (p?.kind === 'binary') p.spec = cleanUrl(p.spec);
	return h;
}
export async function getRepair(id: string, by: number): Promise<Repair> {
	if (!uuid.test(id)) throw new Error('Propuesta no disponible.');
	const r = await row<Stored>(
		'select r.* from agent_repairs r join agents a on a.id=r.agent_id where r.id=$1 and r.person_id=$2 and a.person_id=$2 and a.deleted_at is null',
		[id, by],
	);
	if (!r) throw new Error('Propuesta no disponible.');
	const {
		definition_digest: _digest,
		request_id: _request,
		request_digest: _requestDigest,
		continuation_id: _continuation,
		...view
	} = r;
	return { ...view, before: { ...view.before, harness: harnessForDisplay(view.before.harness) } };
}
export async function diagnose(agentId: number, by: number): Promise<Diagnosis> {
	const a = await owner(agentId, by);
	const report: Diagnosis = {
		revision: a.config_revision,
		at: Date.now(),
		configuration: { role: a.role, model: a.model, harness: harnessForDisplay(a.harness) },
		findings: [],
		accesses: [],
	};
	const finding = (
		code: string,
		level: 'error' | 'warning' | 'info',
		summary: string,
		fields: string[],
		suggestion: string,
	) => report.findings.push({ code, level, summary, fields, suggestion });
	try {
		validateHarness(a.harness);
	} catch {
		finding(
			'harness',
			'error',
			'El harness no cumple el esquema vigente.',
			['harness'],
			'Proponer un manifiesto corregido, mostrar diferencias y probarlo antes de aplicarlo.',
		);
	}
	try {
		validateContract({ name: a.name, prompt: a.role });
	} catch {
		finding(
			'contract',
			'error',
			'El contrato no es válido.',
			['role'],
			'Proponer el contrato corregido sin ampliar accesos por cuenta propia.',
		);
	}
	try {
		await (await import('./tasks')).checkRunnable(a);
	} catch (e) {
		// checkRunnable messages are platform-owned; never include raw vendor bodies or credentials.
		const known = ['Falta tu CLIProxyAPI', 'modelo que ya no', 'inicialización', 'cuota de tareas'];
		const raw = (e as Error).message;
		finding(
			'admission',
			'error',
			known.some((s) => raw.includes(s)) ? raw : 'No se pudo verificar el acceso al proveedor/modelo.',
			['modelo', 'Configuración → API Key'],
			'Revisar modelo, URL y credenciales en el formulario privado. Un fallo de conexión no demuestra que la clave sea incorrecta.',
		);
	}
	const keys = await accesses.listKeys(by),
		mcp = await accesses.listMcp(by),
		names = await rows<{ id: number; name: string }>(
			'select id,name from agents where person_id=$1 and deleted_at is null',
			[by],
		);
	for (const k of keys) {
		const granted = k.agents.includes(agentId);
		report.accesses.push({
			kind: 'key',
			id: k.id,
			name: k.name,
			granted,
			fields: ['dominios', 'concesión al agente', 'valor (formulario privado)'],
			usedBy: names.filter((n) => k.agents.includes(n.id)),
		});
		if (granted && !k.expose_real && !accesses.proxyConfig())
			finding(
				`key:${k.id}`,
				'error',
				`El acceso ${k.name} está concedido pero falta el proxy de salida.`,
				['dominios', 'proxy de plataforma'],
				'Pedir al administrador configurar el proxy; no exponer el valor real como arreglo automático.',
			);
	}
	for (const m of mcp) {
		const granted = m.agents.includes(agentId);
		report.accesses.push({
			kind: 'mcp',
			id: m.id,
			name: m.name,
			granted,
			usedBy: names.filter((n) => m.agents.includes(n.id)),
			fields: [
				'URL o comando',
				...m.headers.map((h) => h.name),
				...m.env.map((e) => e.name),
				'OAuth',
				'concesión al agente',
			],
		});
		if (granted)
			finding(
				`mcp:${m.id}`,
				'info',
				`${m.name}: concedido; su conexión se comprueba desde la computadora del agente.`,
				['URL o comando', 'encabezados/variables', 'OAuth'],
				'Comprobar tools/list desde la computadora. Ante 401 revisar autenticación; ante 403 revisar permisos. No cambiar URL ni credenciales sólo por un timeout.',
			);
	}
	const cached = await row<{ report: NonNullable<Diagnosis['runtime']> }>(
		"select report from agent_diagnoses where agent_id=$1 and person_id=$2 and revision=$3 and checked_at>now()-interval '5 minutes'",
		[agentId, by, a.config_revision],
	);
	if (cached) report.runtime = cached.report;
	return report;
}
async function runIdentity(runId: number) {
	const r = await row<{
		agent_id: number;
		person_id: number;
		owner_requested: boolean;
		conversation_id: number;
		kind: string;
		status: string;
	}>(
		`select r.agent_id,r.person_id,r.conversation_id,r.kind,r.status,
	 coalesce((select m.person_id=r.person_id or m.source in ('cron','hook') from messages m where m.run_id=r.id and m.routed_as='new_run' order by m.id limit 1),false) as owner_requested
	 from runs r where r.id=$1`,
		[runId],
	);
	if (!r || r.kind !== 'task' || !['running', 'blocked'].includes(r.status) || !r.owner_requested)
		throw new Error('El mantenimiento se solicita desde una tarea del dueño y sólo por el agente principal.');
	await owner(r.agent_id, r.person_id);
	return r;
}
async function accessAction(
	kind: 'grant_key' | 'grant_mcp',
	accessId: unknown,
	by: number,
	on?: Exec,
): Promise<RepairAction> {
	if (!Number.isSafeInteger(accessId)) throw new Error('Elige un acceso existente por su ID.');
	const list = kind === 'grant_key' ? await accesses.listKeys(by) : await accesses.listMcp(by);
	const item = list.find((x) => x.id === accessId);
	if (!item) throw new Error('El acceso no existe o no pertenece al dueño.');
	// Include encrypted fields in the fingerprint, never the view: replacing a secret invalidates approval,
	// even if both writes occurred within the same millisecond of the public timestamp parser.
	const stored = await row(
		`select * from ${kind === 'grant_key' ? 'person_keys' : 'person_mcp'} where id=$1 and person_id=$2`,
		[accessId, by],
		on,
	);
	if (!stored) throw new Error('El acceso ya no existe.');
	return { kind, accessId: item.id, name: item.name, fingerprint: digest({ item, stored }) };
}
function managedPackages(packages: Install[]) {
	for (const p of packages)
		if (p.kind === 'binary') {
			const u = new URL(p.spec);
			if (u.username || u.password || u.search || u.hash)
				throw new Error('La descarga propuesta no admite credenciales ni query en la URL.');
		}
	if (
		packages.some(
			(p) =>
				/(?:pi-coding-agent|agents-sandbox|supervisor)/i.test(p.spec) ||
				/^(?:pi|agents-pi|node|npm|npx|uv|python[0-9.]*)$/.test(p.name ?? ''),
		)
	)
		throw new Error('El runtime de plataforma se actualiza con Computadora → Versiones.');
}
function safeHarness(raw: unknown) {
	const h = validateHarness(raw);
	managedPackages(h.installs ?? []);
	// Proposed headers/env are references, never literal credentials; no URL-carried credentials.
	for (const m of h.mcp ?? []) {
		if (m.url) {
			const u = new URL(m.url);
			if (u.username || u.password || u.search || u.hash)
				throw new Error('La URL MCP propuesta no puede contener credenciales, query ni fragmento. Usa Accesos.');
		}
		for (const p of [...m.headers, ...m.env])
			if (!/^\$\{[A-Z][A-Z0-9_]{1,63}\}$/.test(p.value))
				throw new Error('Los campos MCP propuestos deben referenciar ${VARIABLE}; guarda los secretos en Accesos.');
	}
	return h;
}
export async function propose(runId: number, input: Record<string, unknown>) {
	const r = await runIdentity(runId),
		a = await owner(r.agent_id, r.person_id);
	if (typeof input.requestId !== 'string' || !uuid.test(input.requestId))
		throw new Error('Falta la identidad de la propuesta.');
	const previous = await row<Stored>('select * from agent_repairs where run_id=$1 and request_id=$2', [
		runId,
		input.requestId,
	]);
	const requestDigest = digest(input);
	if (previous) {
		if (previous.request_digest !== requestDigest) throw new Error('Esta identidad ya corresponde a otra propuesta.');
		return getRepair(previous.id, r.person_id);
	}
	const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
	if (!reason || reason.length > 1500)
		throw new Error('Explica el problema y la evidencia, sin secretos (hasta 1500 caracteres).');
	let action: RepairAction;
	let automatic = false,
		policy =
			'Requiere aprobación del dueño. Se aplica al quedar libre la computadora, conserva archivos y conversación y crea una revisión nueva. No concede permisos administrativos.';
	if (input.kind === 'configuration') {
		const contract = validateContract({ name: a.name, prompt: input.role ?? a.role });
		action = { kind: 'configuration', role: contract.prompt, harness: safeHarness(input.harness ?? a.harness) };
		if (action.harness.installs?.length && digest(action.harness.installs) !== digest(a.harness?.installs ?? []))
			policy +=
				' Atención: cambian las CLI persistentes del harness. Su preparación existente puede ejecutar scripts de paquetes con permisos del sandbox, fuera de los límites del instalador local. La sonda no verifica esos paquetes. Autoriza sólo dependencias confiables; para dependencias locales prefiere una propuesta install separada.';
	} else if (input.kind === 'grant_key' || input.kind === 'grant_mcp') {
		action = await accessAction(input.kind, input.accessId, r.person_id);
		policy +=
			' Sólo agrega la concesión a este agente; no modifica campos ni elimina concesiones de otros agentes. Puede habilitar acceso a datos o acciones del servicio.';
	} else if (input.kind === 'install') {
		if (!a.harness.tools.includes('bash') || a.harness.restrictions.readOnlyFiles)
			throw new Error('Instalar dependencias requiere bash aprobado. Propón primero el cambio de harness.');
		const h = validateHarness({ ...a.harness, installs: input.packages });
		if (!h.installs?.length || h.installs.length > 5)
			throw new Error('Propón entre 1 y 5 dependencias con versión exacta.');
		managedPackages(h.installs);
		action = { kind: 'install', packages: h.installs };
		({ automatic, policy } = installPolicy(h.installs));
	} else throw new Error('Tipo de reparación no admitido.');
	const created = await tx(async (c) => {
		const current = await owner(a.id, r.person_id, c);
		const duplicate = await row<Stored>(
			'select * from agent_repairs where run_id=$1 and request_id=$2',
			[runId, input.requestId],
			c,
		);
		if (duplicate) {
			if (duplicate.request_digest !== requestDigest)
				throw new Error('Esta identidad ya corresponde a otra propuesta.');
			return duplicate.id;
		}
		if (configFingerprint(current) !== configFingerprint(a))
			throw new Error('La configuración cambió; vuelve a diagnosticar.');
		if (
			await row(
				"select 1 from agent_repairs where agent_id=$1 and status in ('pending','approved','running')",
				[a.id],
				c,
			)
		)
			throw new Error('Ya hay una propuesta abierta para este agente; consulta su estado antes de crear otra.');
		if (
			await row(
				"select 1 from computer_update_items where agent_id=$1 and status in ('queued','waiting','validating','applying')",
				[a.id],
				c,
			)
		)
			throw new Error('Ya hay una actualización de computadora programada.');
		const id = randomUUID(),
			code = `R${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
		await exec(
			`insert into agent_repairs(id,code,agent_id,person_id,run_id,conversation_id,revision,definition_digest,request_id,status,reason,action,before,automatic,policy,request_digest)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
			[
				id,
				code,
				a.id,
				r.person_id,
				runId,
				r.conversation_id,
				a.config_revision,
				configFingerprint(a),
				input.requestId,
				automatic ? 'approved' : 'pending',
				reason,
				JSON.stringify(action),
				JSON.stringify({ role: a.role, harness: harnessForDisplay(a.harness) }),
				automatic,
				policy,
				requestDigest,
			],
			c,
		);
		return id;
	});
	await publish(created);
	return getRepair(created, r.person_id);
}
async function publish(id: string) {
	const r = await row<Stored>('select * from agent_repairs where id=$1', [id]);
	if (!r) return;
	const tasks = await import('./tasks');
	await tasks.recordEvent(r.run_id, 'self_repair', { id: r.id, status: r.status });
	hub.toPerson(r.person_id, { t: 'self-repair', agentId: r.agent_id, id: r.id });
	// Private owner destinations only; never send configuration into a shared/guest group.
	await (await import('./whatsapp')).maintenanceNotice(r.run_id, repairText(r));
	(await import('./inbox')).requestRoute(r.agent_id);
}
export async function decide(id: string, by: number, approve: boolean) {
	await getRepair(id, by);
	await tx(async (c) => {
		const snapshot = (await row<Stored>('select * from agent_repairs where id=$1', [id], c))!;
		const a = await owner(snapshot.agent_id, by, c);
		const r = (await row<Stored>('select * from agent_repairs where id=$1 for update', [id], c))!;
		if (r.status !== 'pending') {
			if ((approve && ['approved', 'running', 'done'].includes(r.status)) || (!approve && r.status === 'rejected'))
				return;
			throw new Error('La propuesta ya terminó o tiene otra decisión.');
		}
		if (r.expires_at <= Date.now()) throw new Error('La propuesta caducó; solicita otra.');
		if (approve && configFingerprint(a) !== r.definition_digest)
			throw new Error('La configuración cambió; vuelve a diagnosticar antes de autorizar.');
		if (
			approve &&
			(await row(
				"select 1 from computer_update_items where agent_id=$1 and status in ('queued','waiting','validating','applying')",
				[a.id],
				c,
			))
		)
			throw new Error('Hay una actualización de imagen programada. Espera a que termine.');
		await exec(
			'update agent_repairs set status=$2,decided_by=$3,decided_at=now(),updated_at=now() where id=$1',
			[id, approve ? 'approved' : 'rejected', by],
			c,
		);
	});
	await publish(id);
	return getRepair(id, by);
}
export async function decideCode(code: string, by: number, agentIds: number[], approve: boolean) {
	const r = await row<{ id: string }>(
		'select id from agent_repairs where code=$1 and person_id=$2 and agent_id=any($3::bigint[])',
		[code, by, agentIds],
	);
	if (!r) throw new Error('Propuesta no disponible para este dueño y grupo.');
	return decide(r.id, by, approve);
}
export async function installation(runId: number, id: string) {
	const run = await runIdentity(runId),
		r = await getRepair(id, run.person_id);
	if (r.agent_id !== run.agent_id || r.conversation_id !== run.conversation_id || r.action.kind !== 'install')
		throw new Error('Instalación no disponible en esta conversación.');
	if (r.status === 'done') return { completed: r };
	return tx(async (c) => {
		const a = await owner(r.agent_id, run.person_id, c);
		const locked = (await row<Stored>('select * from agent_repairs where id=$1 for update', [id], c))!;
		if (!['approved', 'running'].includes(locked.status) || locked.expires_at <= Date.now())
			throw new Error('La instalación no está autorizada o caducó.');
		if (configFingerprint(a) !== locked.definition_digest || !a.harness.tools.includes('bash'))
			throw new Error('El harness cambió; solicita otra propuesta.');
		await exec("update agent_repairs set status='running',updated_at=now() where id=$1", [id], c);
		return {
			id,
			packages: (locked.action as Extract<RepairAction, { kind: 'install' }>).packages,
			automatic: locked.automatic,
		};
	});
}
export async function installationResult(runId: number, id: string, ok: boolean) {
	const run = await runIdentity(runId),
		r = await getRepair(id, run.person_id);
	if (r.agent_id !== run.agent_id || r.conversation_id !== run.conversation_id || r.action.kind !== 'install')
		throw new Error('Instalación no disponible.');
	await exec("update agent_repairs set status=$2,result=$3,updated_at=now() where id=$1 and status='running'", [
		id,
		ok ? 'done' : 'failed',
		ok
			? 'El instalador local completó la instalación y comprobó los artefactos. El agente debe comprobar la función que necesita antes de continuar.'
			: 'El instalador falló o superó los límites. No se certifica el funcionamiento; revisa el diagnóstico local sin compartir secretos.',
	]);
	await publish(id);
	return getRepair(id, run.person_id);
}
async function continuation(r: Stored, c: Exec) {
	if (r.continuation_id) return;
	const original = await row<{ source: string; context: unknown }>(
		'select source,context from messages where run_id=$1 order by id limit 1',
		[r.run_id],
		c,
	);
	const text =
		r.action.kind === 'install'
			? `La instalación ${r.code} está autorizada. Usa self_maintenance con action execute e id ${r.id}; no la instales por otro camino. Comprueba la herramienta y retoma sólo el trabajo pendiente de esta conversación.`
			: `La reparación ${r.code} terminó: ${r.result}. Retoma sólo lo pendiente de tu tarea anterior desde la memoria de esta conversación. Verifica el estado real antes de continuar. No repitas envíos, pagos ni otras acciones externas ya realizadas. Si no hay un punto seguro, pregunta al dueño.`;
	const m = await row<{ id: number }>(
		`insert into messages(agent_id,person_id,conversation_id,source,text,context,dedupe_key)
	 select $1,$2,$3,$4,$5,$6,$7 where exists(select 1 from conversations where id=$3 and deleted_at is null and archived_at is null)
	 on conflict(agent_id,dedupe_key) do update set dedupe_key=excluded.dedupe_key returning id`,
		[
			r.agent_id,
			r.person_id,
			r.conversation_id,
			original?.source === 'whatsapp' ? 'whatsapp' : 'web',
			text,
			JSON.stringify(original?.context ?? {}),
			`repair:${r.id}`,
		],
		c,
	);
	if (m) await exec('update agent_repairs set continuation_id=$2 where id=$1', [r.id, m.id], c);
}
export async function attemptRepair(id: string, docker: Pick<DockerSandbox, 'probeHarness'> = new DockerSandbox()) {
	const r = await row<Stored>('select * from agent_repairs where id=$1', [id]);
	if (!r || !repairPending(r) || r.status === 'pending') return true;
	if (r.expires_at <= Date.now()) {
		await exec(
			"update agent_repairs set status='expired',updated_at=now() where id=$1 and status in ('approved','running')",
			[id],
		);
		await publish(id);
		return true;
	}
	if (await activeRun(r.agent_id)) return false;
	if (r.action.kind === 'install') {
		await tx(async (c) => {
			await owner(r.agent_id, r.person_id, c);
			const locked = (await row<Stored>('select * from agent_repairs where id=$1 for update', [id], c))!;
			if (['approved', 'running'].includes(locked.status)) await continuation(locked, c);
		});
		(await import('./inbox')).requestRoute(r.agent_id);
		return false;
	}
	let lease: string | null = null;
	try {
		const a = await owner(r.agent_id, r.person_id);
		if (configFingerprint(a) !== r.definition_digest)
			throw new Error('La configuración cambió; no se sobrescribió. Vuelve a diagnosticar.');
		if (r.action.kind === 'configuration') {
			lease = await claimHarnessValidation(a.id, r.person_id);
			await exec("update agent_repairs set status='running',updated_at=now() where id=$1 and status='approved'", [id]);
			const h = safeHarness(r.action.harness);
			validateContract({ name: a.name, prompt: r.action.role });
			if (!a.harness_image || !/^sha256:[a-f0-9]{64}$/.test(a.harness_image))
				throw new Error('Falta una imagen aprobada inmutable; revisa Computadora → Versiones.');
			const probe = await docker.probeHarness(a.harness_image, h, process.env.AGENTS_INSTANCE ?? 'dev');
			if (
				probe.digest !== harnessHash(h) ||
				JSON.stringify(probe.tools) !== JSON.stringify(runtimeToolNames(h)) ||
				JSON.stringify(probe.skills) !== JSON.stringify(h.skills.map((s) => s.name)) ||
				JSON.stringify(probe.plugins) !== JSON.stringify(h.plugins)
			)
				throw new Error('La prueba no confirmó el harness propuesto.');
		}
		await tx(async (c) => {
			const current = await owner(r.agent_id, r.person_id, c);
			const locked = (await row<Stored>('select * from agent_repairs where id=$1 for update', [id], c))!;
			if (!['approved', 'running'].includes(locked.status)) return;
			if (locked.expires_at <= Date.now() || configFingerprint(current) !== r.definition_digest)
				throw new Error('La propuesta caducó o cambió la configuración; no se aplicó.');
			if (await activeRun(r.agent_id, c)) throw new ImageUpdateWaiting('busy', 'Esperando computadora libre.');
			if (lease && !(await row('select 1 from sandbox_image_checks where token=$1 and expires_at>now()', [lease], c)))
				throw new Error('La prueba caducó.');
			if (r.action.kind === 'configuration')
				await exec(
					'update agents set role=$2,harness=$3,config_revision=config_revision+1 where id=$1',
					[r.agent_id, r.action.role, JSON.stringify(r.action.harness)],
					c,
				);
			else if (r.action.kind === 'grant_key' || r.action.kind === 'grant_mcp') {
				const table = r.action.kind === 'grant_key' ? 'person_keys' : 'person_mcp';
				await row(
					`select id from ${table} where id=$1 and person_id=$2 for update`,
					[r.action.accessId, r.person_id],
					c,
				);
				const now = await accessAction(r.action.kind, r.action.accessId, r.person_id, c);
				if (now.kind === 'configuration' || now.kind === 'install' || now.fingerprint !== r.action.fingerprint)
					throw new Error('El acceso cambió desde la propuesta; solicita otra.');
				const grants = r.action.kind === 'grant_key' ? 'person_key_grants' : 'person_mcp_grants',
					column = r.action.kind === 'grant_key' ? 'key_id' : 'mcp_id';
				await exec(
					`insert into ${grants}(${column},agent_id) values($1,$2) on conflict do nothing`,
					[r.action.accessId, r.agent_id],
					c,
				);
				await exec('update agents set config_revision=config_revision+1 where id=$1', [r.agent_id], c);
			}
			await saveRevision((await agents.get(r.agent_id, c))!, c);
			await exec(
				"update agent_repairs set status='done',result=$2,updated_at=now() where id=$1",
				[id, `Configuración aplicada y comprobada; revisión ${current.config_revision + 1}.`],
				c,
			);
			await continuation({ ...locked, result: `Configuración aplicada; revisión ${current.config_revision + 1}.` }, c);
		});
		await publish(id);
		return true;
	} catch (e) {
		if (e instanceof ImageUpdateWaiting) return false;
		// Do not publish raw Docker/vendor output: it may contain credentials.
		await exec(
			"update agent_repairs set status='failed',result=$2,updated_at=now() where id=$1 and status in ('approved','running')",
			[
				id,
				'No se pudo aplicar o comprobar la propuesta. La configuración previa se conserva. Revisa que la revisión, el acceso y la imagen sigan vigentes y vuelve a diagnosticar.',
			],
		);
		await publish(id);
		return true;
	} finally {
		if (lease) await exec('delete from sandbox_image_checks where token=$1', [lease]);
	}
}
let operational = false;
const repairWorkflow = DBOS.registerWorkflow(
	async (id: string) => {
		for (let round = 0; ; round++) {
			if (await DBOS.runStep(async () => (operational ? attemptRepair(id) : false), { name: `repair-${round}` }))
				return;
			await DBOS.sleep(5000);
		}
	},
	{ name: 'selfRepairV1' },
);
export async function recoverRepairs() {
	operational = true;
	await exec(
		"update agent_repairs r set status='expired',updated_at=now() where status='pending' and (expires_at<=now() or not exists(select 1 from agents a where a.id=r.agent_id and a.person_id=r.person_id and a.deleted_at is null))",
	);
	for (const r of await rows<Stored>("select * from agent_repairs where status in ('approved','running')")) {
		const workflowID = `self-repair:${r.id}`,
			state = await DBOS.getWorkflowStatus(workflowID);
		if (state && ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(state.status)) {
			await exec(
				"update agent_repairs set status='failed',result='El job se interrumpió. Diagnostica de nuevo; no se repiten acciones externas.',updated_at=now() where id=$1",
				[r.id],
			);
			await publish(r.id);
		} else await DBOS.startWorkflow(repairWorkflow, { workflowID })(r.id);
	}
}
export function startRepairReconciler() {
	let busy = false;
	const timer = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			await recoverRepairs();
		} catch (e) {
			console.warn('self-repair reconciliation failed');
		} finally {
			busy = false;
		}
	}, 5000);
	timer.unref();
}
export async function agentRequest(runId: number, input: Record<string, unknown>) {
	const r = await runIdentity(runId);
	if (input.action === 'diagnose') return diagnose(r.agent_id, r.person_id);
	if (input.action === 'diagnosis_result') {
		const a = await owner(r.agent_id, r.person_id),
			q = input.runtime as
				{ tools?: { ok?: unknown }; mcp?: { name?: unknown; ok?: unknown }[]; undelivered?: unknown[] } | undefined;
		const allowed = new Set([
			...(a.harness.mcp ?? []).map((m) => m.name),
			...(await accesses.grantedTo(a.id)).mcp.map((m) => m.name),
		]);
		const keys = new Set((await accesses.grantedTo(a.id)).keys.map((k) => k.name));
		const report: NonNullable<Diagnosis['runtime']> = {
			at: Date.now(),
			toolsOk: q?.tools?.ok === true,
			mcp: (Array.isArray(q?.mcp) ? q.mcp : [])
				.filter((m) => typeof m.name === 'string' && allowed.has(m.name))
				.slice(0, 28)
				.map((m) => ({ name: String(m.name), ok: m.ok === true ? true : m.ok === null ? null : false })),
			undelivered: (Array.isArray(q?.undelivered) ? q.undelivered : [])
				.filter((n): n is string => typeof n === 'string' && (keys.has(n) || allowed.has(n)))
				.slice(0, 28),
		};
		await exec(
			`insert into agent_diagnoses(agent_id,person_id,run_id,revision,report) values($1,$2,$3,$4,$5)
		 on conflict(agent_id) do update set person_id=excluded.person_id,run_id=excluded.run_id,revision=excluded.revision,report=excluded.report,checked_at=now()`,
			[a.id, r.person_id, runId, a.config_revision, JSON.stringify(report)],
		);
		const diagnosis = await diagnose(a.id, r.person_id);
		await (await import('./tasks')).recordEvent(runId, 'self_diagnosis', {});
		await (
			await import('./whatsapp')
		).maintenanceNotice(
			runId,
			`Diagnóstico de configuración · revisión ${diagnosis.revision}\n${diagnosis.findings.map((f) => `${f.summary}\nRevisar: ${f.fields.join(', ') || '—'}. ${f.suggestion}`).join('\n\n')}\n\nComprobación en la computadora: herramientas ${report.toolsOk ? 'preparadas' : 'no confirmadas'}.\n${report.mcp.map((m) => `${m.name}: ${m.ok === true ? 'conectado' : m.ok === null ? 'falta iniciar sesión' : 'no conectó; revisa URL, autenticación y permisos'}`).join('\n')}\nNunca envíes secretos por chat.`,
		);
		return diagnosis;
	}
	if (input.action === 'propose') return propose(runId, input);
	if (input.action === 'status') {
		const p = await getRepair(String(input.id), r.person_id);
		if (p.agent_id !== r.agent_id || p.conversation_id !== r.conversation_id)
			throw new Error('Propuesta no disponible en esta conversación.');
		return p;
	}
	throw new Error('Acción no admitida.');
}
