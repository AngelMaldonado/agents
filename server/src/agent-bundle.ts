// .cubyagent (Angel 13-nov-2026): an agent as a file, to take it to another instance (dev, prod, another team's).
// A zip with its own extension: its whole configuration (contract, model, harness, personality, style,
// switches), its schedules (they arrive paused), its lessons, its simulator's people, what it needs (accesses by
// name, WhatsApp contacts by number) and the files of its computer (~/work). Never its secrets, its browser
// profile, its conversations or its runs. Importing it checks the file, its harness against this instance's
// catalog and the isolated test on this instance's image; only then the agent is created, and what it needs is
// matched: accesses of the importer with the same name are granted, contacts with the same number switched on.
import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exec, row, rows, tx } from './db';
import * as agents from './agents';
import * as channels from './channels';
import * as lessons from './lessons';
import { harnessHash, validateHarness, type Harness } from './harnesses';
import { runtimeToolNames } from '../../sandbox/harness';
import { DockerSandbox } from './sandbox/docker';
import { settings } from './settings';
import { stateMount, STATE_DIR } from './state';
import { cleanPersonality } from './personality';
import { SOUL_CHARS, STYLES } from '../../shared/souls';

export const FORMAT = 'cubyagent';
export const VERSION = 1;
/** A .cubyagent, at most (bytes); its computer's files count. */
export const MAX_BYTES = 300 * 1024 * 1024;

/** The engine its files and its test go through; tests replace it. */
export const bundleEngine = {
	docker: new DockerSandbox() as Pick<DockerSandbox, 'imageId' | 'probeHarness' | 'readVolume' | 'writeVolume'>,
};

type Manifest = {
	format: string;
	version: number;
	exported: { at: string; by: string; from: string; revision: number };
	agent: {
		name: string;
		model: string;
		seed: string;
		goalMode: boolean;
		inactivityHours: number;
		personality: Record<string, number>;
		style: string | null;
		whatsappNotify: boolean;
		simulatedPayments: boolean;
		simulatedConversations: boolean;
	};
	includes: { schedules: number; lessons: number; contacts: number; workspace: boolean };
};
type Requirements = {
	accesses: { sites: string[]; mcp: string[]; keys: { name: string; domains: string[] }[] };
	contacts: { phone: string; label: string; role: 'external' | 'direct' | 'guest'; enabled: boolean }[];
};
type Schedule = { cron: string; message: string };
type BundleLesson = { text: string; helpful: number; harmful: number; pinned: boolean };
type Actor = { chat: string; persona: string | null; goal: string | null; auto: boolean };

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (v: unknown) => strToU8(`${JSON.stringify(v, null, 2)}\n`);
const slug = (s: string) =>
	s
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40) || 'agente';

async function idle(agentId: number) {
	if (
		await row("select 1 from runs where agent_id = $1 and status in ('queued','starting','running','blocked')", [
			agentId,
		])
	)
		throw new Error('Espera a que termine su trabajo: su computadora se exporta apagada.');
}

/** Its file: everything about it but its secrets and its history. */
export async function exportAgent(agent: agents.Agent, by: { id: number; name: string }) {
	if (agent.person_id !== by.id) throw new Error('Sólo su dueño lo exporta.');
	await idle(agent.id);
	const a = (await row<{
		seed: string;
		goal_mode: boolean;
		inactivity_hours: number;
		whatsapp_notify: boolean;
		simulated_payments: boolean;
		simulated_conversations: boolean;
		state_ref: string;
	}>(
		'select seed, goal_mode, inactivity_hours, whatsapp_notify, simulated_payments, simulated_conversations, state_ref from agents where id = $1',
		[agent.id],
	))!;
	const schedules: Schedule[] = (await channels.schedulesIfRunning(agent.id)).map((s) => ({
		cron: s.cron,
		message: s.message,
	}));
	const learned: BundleLesson[] = (await lessons.list(agent.id)).map((l) => ({
		text: l.text,
		helpful: l.helpful,
		harmful: l.harmful,
		pinned: l.pinned,
	}));
	const requirements: Requirements = {
		accesses: {
			sites: (
				await rows<{ name: string }>(
					'select c.name from credentials c join credential_grants g on g.credential_id = c.id where g.agent_id = $1 order by c.name',
					[agent.id],
				)
			).map((r) => r.name),
			mcp: (
				await rows<{ name: string }>(
					'select m.name from person_mcp m join person_mcp_grants g on g.mcp_id = m.id where g.agent_id = $1 order by m.name',
					[agent.id],
				)
			).map((r) => r.name),
			keys: await rows<{ name: string; domains: string[] }>(
				'select k.name, k.domains from person_keys k join person_key_grants g on g.key_id = k.id where g.agent_id = $1 order by k.name',
				[agent.id],
			),
		},
		// Its contacts by number: where the same numbers exist, they are switched on for it again.
		contacts: await rows<Requirements['contacts'][number]>(
			`select x.phone, coalesce(p.label, '') as label,
			   case when p.external then 'external' when p.direct then 'direct' else 'guest' end as role, x.enabled
			 from whatsapp_agent_phones x left join whatsapp_phones p on p.number_id = x.number_id and p.phone = x.phone
			 where x.agent_id = $1 order by x.phone`,
			[agent.id],
		),
	};
	const actors = await rows<Actor>(
		'select chat, persona, goal, auto from whatsapp_sim_actors where agent_id = $1 order by chat',
		[agent.id],
	);
	// The files of its computer (~/work), as a tar; nothing when its computer never ran.
	const workspace = agent.harness_image
		? await bundleEngine.docker.readVolume(
				stateMount({ id: agent.id, state_ref: a.state_ref }, ''),
				agent.harness_image,
				`${STATE_DIR}/work`,
			)
		: null;
	if (workspace && workspace.length > MAX_BYTES)
		throw new Error(`Los archivos de su computadora pasan de ${MAX_BYTES / 1024 / 1024} MB.`);
	const manifest: Manifest = {
		format: FORMAT,
		version: VERSION,
		exported: {
			at: new Date().toISOString(),
			by: by.name,
			from: process.env.AGENTS_INSTANCE ?? 'dev',
			revision: agent.config_revision,
		},
		agent: {
			name: agent.name,
			model: agent.model,
			seed: a.seed,
			goalMode: a.goal_mode,
			inactivityHours: a.inactivity_hours,
			personality: (agent.personality ?? {}) as Record<string, number>,
			style: agent.style,
			whatsappNotify: a.whatsapp_notify,
			simulatedPayments: a.simulated_payments,
			simulatedConversations: a.simulated_conversations,
		},
		includes: {
			schedules: schedules.length,
			lessons: learned.length,
			contacts: requirements.contacts.length,
			workspace: !!workspace,
		},
	};
	const files: Record<string, Uint8Array> = {
		'agent.json': json(manifest),
		'CONTRACT.md': strToU8(agent.role),
		...(agent.soul ? { 'SOUL.md': strToU8(agent.soul) } : {}),
		'harness.json': json(agent.harness),
		'schedules.json': json(schedules),
		'lessons.json': json(learned),
		'requirements.json': json(requirements),
		'simulation.json': json({ actors }),
		...(workspace ? { 'workspace.tar': workspace } : {}),
	};
	files['checksums.json'] = json(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])));
	return {
		name: `${slug(agent.name)}-r${agent.config_revision}.cubyagent`,
		bytes: zipSync(files, { level: 6 }),
	};
}

/** Its file read and checked: what it is, and whether this instance can take it. */
function read(bytes: Uint8Array) {
	if (bytes.length > MAX_BYTES) throw new Error(`El archivo pasa de ${MAX_BYTES / 1024 / 1024} MB.`);
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch {
		throw new Error('Ese archivo no es un .cubyagent.');
	}
	const text = (name: string) => (files[name] ? strFromU8(files[name]) : null);
	const parse = <T>(name: string, fallback: T): T => {
		const t = text(name);
		if (t === null) return fallback;
		try {
			return JSON.parse(t) as T;
		} catch {
			throw new Error(`${name} está dañado.`);
		}
	};
	const manifest = parse<Manifest | null>('agent.json', null);
	if (!manifest || manifest.format !== FORMAT) throw new Error('Ese archivo no es un .cubyagent.');
	if (manifest.version > VERSION)
		throw new Error(`Es de una versión más nueva del formato (${manifest.version}); actualiza esta plataforma.`);
	const sums = parse<Record<string, string>>('checksums.json', {});
	for (const [name, sum] of Object.entries(sums))
		if (!files[name] || sha(files[name]) !== sum) throw new Error(`El archivo está alterado o incompleto (${name}).`);
	return {
		manifest,
		contract: text('CONTRACT.md') ?? '',
		soul: text('SOUL.md'),
		harnessRaw: parse<unknown>('harness.json', null),
		schedules: parse<Schedule[]>('schedules.json', []),
		lessons: parse<BundleLesson[]>('lessons.json', []),
		requirements: parse<Requirements>('requirements.json', {
			accesses: { sites: [], mcp: [], keys: [] },
			contacts: [],
		}),
		actors: parse<{ actors: Actor[] }>('simulation.json', { actors: [] }).actors,
		workspace: files['workspace.tar'] ?? null,
	};
}

/** What the importer has that it needs: accesses by name, contacts by number. */
async function matches(personId: number, req: Requirements) {
	const mine = async (sql: string) => (await rows<{ id: number; name: string }>(sql, [personId])).map((r) => r);
	const sites = await mine('select id, name from credentials where person_id = $1');
	const mcp = await mine('select id, name from person_mcp where person_id = $1');
	const keys = await mine('select id, name from person_keys where person_id = $1');
	const find = (list: { id: number; name: string }[], name: string) =>
		list.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? null;
	const accesses = [
		...req.accesses.sites.map((name) => ({ kind: 'site' as const, name, have: find(sites, name) })),
		...req.accesses.mcp.map((name) => ({ kind: 'mcp' as const, name, have: find(mcp, name) })),
		...req.accesses.keys.map((k) => ({ kind: 'key' as const, name: k.name, have: find(keys, k.name) })),
	];
	const contacts = await Promise.all(
		req.contacts.map(async (c) => ({
			...c,
			have: await row<{ number_id: number; label: string }>(
				"select number_id, label from whatsapp_phones where phone = $1 order by (list = 'allow') desc, number_id limit 1",
				[c.phone],
			),
		})),
	);
	return { accesses, contacts };
}

/** What importing it would do, before doing it. */
export async function inspect(bytes: Uint8Array, personId: number) {
	const b = read(bytes);
	let harnessError: string | null = null;
	let tools: string[] = [];
	try {
		const h = validateHarness(b.harnessRaw);
		tools = h.tools;
	} catch (e) {
		harnessError = (e as Error).message;
	}
	const model = settings().models.some((m) => m.id === b.manifest.agent.model) ? null : b.manifest.agent.model;
	const m = await matches(personId, b.requirements);
	return {
		manifest: b.manifest,
		contract: b.contract,
		soul: b.soul,
		style: STYLES.find((s) => s.key === b.manifest.agent.style)?.name ?? 'Cuby YOLO',
		tools,
		harnessError,
		missingModel: model,
		schedules: b.schedules.length,
		lessons: b.lessons.length,
		actors: b.actors.length,
		workspaceBytes: b.workspace?.length ?? 0,
		accesses: m.accesses.map((x) => ({ kind: x.kind, name: x.name, have: !!x.have })),
		contacts: m.contacts.map((x) => ({
			phone: x.phone,
			label: x.have?.label || x.label,
			role: x.role,
			enabled: x.enabled,
			have: !!x.have,
		})),
	};
}

/** The probe of its harness on this instance's image, as Automejora's: the same tools, skills and plugins. */
async function test(h: Harness) {
	const image = await bundleEngine.docker.imageId(settings().sandboxImage);
	const probe = await bundleEngine.docker.probeHarness(image, h, process.env.AGENTS_INSTANCE ?? 'dev');
	if (
		probe.digest !== harnessHash(h) ||
		JSON.stringify(probe.tools) !== JSON.stringify(runtimeToolNames(h)) ||
		JSON.stringify(probe.skills) !== JSON.stringify(h.skills.map((s) => s.name)) ||
		JSON.stringify(probe.plugins) !== JSON.stringify(h.plugins)
	)
		throw new Error('La computadora de esta plataforma no cargó su harness.');
	return image;
}

/** It becomes an agent of this person here, with all its configuration; what it needs, matched. */
export async function importAgent(bytes: Uint8Array, person: { id: number }) {
	const b = read(bytes);
	const harness = validateHarness(b.harnessRaw);
	const image = await test(harness);
	const a = b.manifest.agent;
	const m = await matches(person.id, b.requirements);
	const made = await tx(async (c) => {
		const created = await agents.create(
			person.id,
			{ name: a.name, role: b.contract, model: a.model, harness, image },
			c,
		);
		const style = STYLES.some((s) => s.key === a.style) ? a.style : null;
		const soul = b.soul?.trim() ? b.soul.trim().slice(0, SOUL_CHARS) : null;
		await exec(
			`update agents set seed = coalesce(nullif($2, ''), seed), goal_mode = $3, inactivity_hours = $4, personality = $5,
			   style = $6, soul = $7, whatsapp_notify = $8, simulated_payments = $9, simulated_conversations = $10 where id = $1`,
			[
				created.id,
				String(a.seed ?? ''),
				!!a.goalMode,
				Number.isInteger(a.inactivityHours) && a.inactivityHours >= 1 && a.inactivityHours <= 720
					? a.inactivityHours
					: 24,
				JSON.stringify(cleanPersonality(a.personality)),
				style,
				soul,
				!!a.whatsappNotify,
				!!a.simulatedPayments,
				!!a.simulatedConversations,
			],
			c,
		);
		// Its lessons, as they were (no trabajo here is theirs).
		for (const l of b.lessons.slice(0, lessons.MAX_LESSONS)) {
			const text = String(l.text ?? '')
				.trim()
				.slice(0, lessons.LESSON_CHARS);
			if (!text || lessons.secretIn(text)) continue;
			await exec(
				'insert into agent_lessons (agent_id, text, helpful, harmful, pinned) values ($1, $2, $3, $4, $5)',
				[created.id, text, Math.max(0, Number(l.helpful) || 0), Math.max(0, Number(l.harmful) || 0), !!l.pinned],
				c,
			);
		}
		// The importer's accesses with the same names.
		for (const x of m.accesses) {
			if (!x.have) continue;
			const table = {
				site: ['credential_grants', 'credential_id'],
				mcp: ['person_mcp_grants', 'mcp_id'],
				key: ['person_key_grants', 'key_id'],
			}[x.kind];
			await exec(
				`insert into ${table[0]} (${table[1]}, agent_id) values ($1, $2) on conflict do nothing`,
				[x.have.id, created.id],
				c,
			);
		}
		// Its contacts, where the same numbers are here.
		for (const x of m.contacts)
			if (x.have)
				await exec(
					`insert into whatsapp_agent_phones (agent_id, number_id, phone, enabled) values ($1, $2, $3, $4)
					 on conflict (agent_id, number_id, phone) do update set enabled = excluded.enabled, updated_at = now()`,
					[created.id, x.have.number_id, x.phone, x.enabled],
					c,
				);
		// Its simulator's people (Conversaciones simuladas).
		for (const x of b.actors)
			if (/^[gde]:[0-9]{8,15}$/.test(String(x.chat)))
				await exec(
					`insert into whatsapp_sim_actors (agent_id, chat, persona, goal, auto) values ($1, $2, $3, $4, $5) on conflict do nothing`,
					[created.id, x.chat, x.persona, x.goal, !!x.auto],
					c,
				);
		return created;
	});
	// Its schedules come paused: they would spend its new owner's quota before they look at them.
	let schedules = 0;
	for (const s of b.schedules.slice(0, 10)) {
		try {
			await channels.addSchedule(made.id, s.cron, s.message);
			schedules++;
		} catch {}
	}
	for (const s of await channels.schedulesIfRunning(made.id)) await channels.pauseSchedule(made.id, s.name, true);
	// The files of its computer, into its new volume.
	let workspace = false;
	if (b.workspace) {
		const fresh = (await row<{ state_ref: string }>('select state_ref from agents where id = $1', [made.id]))!;
		await bundleEngine.docker.writeVolume(
			stateMount({ id: made.id, state_ref: fresh.state_ref }, process.env.AGENTS_INSTANCE ?? 'dev'),
			image,
			STATE_DIR,
			b.workspace,
		);
		workspace = true;
	}
	return {
		agent: await agents.get(made.id),
		granted: m.accesses.filter((x) => x.have).map((x) => x.name),
		missing: m.accesses.filter((x) => !x.have).map((x) => x.name),
		contacts: m.contacts.filter((x) => x.have).length,
		schedules,
		workspace,
	};
}
