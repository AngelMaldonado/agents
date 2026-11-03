// A person's own API keys and MCP servers, granted to their agents like site logins (#24, Bubble).
//
// Values are sealed and write-only. At a run's start the agent gets, for each granted key, either
// its value (expose_real) or a placeholder `agk_…`; the egress proxy (proxy/) swaps a placeholder
// for its value only in requests to that key's domains. Placeholders derive from the run's proxy
// token, so nothing is stored per run: the proxy presents the token, this module recomputes them.
// An MCP server's secret headers/env work the same way, bound to its URL's host (or its domains).
// What an agent still has of its own (agent_secrets, a migration conflict to resolve) wins.
import { createHash, randomBytes } from 'node:crypto';
import { row, rows, exec, tx, hash, type Exec } from './db';
import { seal, open } from './crypto';
import { checkName } from './secrets';
import { validateMcpServer, type McpServer } from '../../sandbox/harness';

export type KeyView = {
	id: number;
	name: string;
	domains: string[];
	expose_real: boolean;
	updated_at: number;
	agents: number[];
};
type Pair = { name: string; secret: boolean; value?: string; value_enc?: string };
export type McpView = Omit<McpServer, 'headers' | 'env'> & {
	id: number;
	headers: { name: string; secret: boolean; value: string | null }[];
	env: { name: string; secret: boolean; value: string | null }[];
	domains: string[];
	expose_real: boolean;
	updated_at: number;
	agents: number[];
};

const MAX_KEYS = 50,
	MAX_MCP = 20,
	MAX_DOMAINS = 10;

// ---------- domains ----------

const HOST = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://API.github.com/x" or "api.github.com" -> "api.github.com"; "*.example.com" stays. */
export function normalizeDomains(raw: unknown): string[] {
	const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/))
		.map((d) => String(d).trim().toLowerCase())
		.filter(Boolean)
		.map((d) => d.replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, ''));
	const out = [...new Set(list)];
	if (out.length > MAX_DOMAINS) throw new Error(`Hasta ${MAX_DOMAINS} dominios.`);
	for (const d of out)
		if (!HOST.test(d)) throw new Error(`«${d}» no es un dominio (por ejemplo api.github.com o *.ejemplo.com).`);
	return out.sort();
}

/** The host a request goes to matches a key's domain (exact, or a subdomain for *.example.com). */
export function domainMatches(host: string, domain: string) {
	const h = host.toLowerCase().replace(/\.$/, '');
	return domain.startsWith('*.') ? h.endsWith(domain.slice(1)) && h.length > domain.length - 1 : h === domain;
}

/** Placeholder of one secret field for one run. Not a secret: the value never leaves the backend. */
export const placeholder = (proxyToken: string, field: string) =>
	`agk_${createHash('sha256').update(`${proxyToken}:${field}`).digest('hex').slice(0, 40)}`;

// ---------- API keys ----------

export function listKeys(personId: number) {
	return rows<KeyView>(
		`select k.id, k.name, k.domains, k.expose_real, k.updated_at,
		        coalesce(array_agg(g.agent_id::int order by g.agent_id) filter (where g.agent_id is not null), '{}') as agents
		 from person_keys k left join person_key_grants g on g.key_id = k.id
		 where k.person_id = $1 group by k.id order by k.name`,
		[personId],
	);
}

/** Creates or replaces a key by its name; without a value, an existing key keeps its own. */
export async function saveKey(
	personId: number,
	input: { name?: unknown; value?: unknown; domains?: unknown; exposeReal?: unknown },
) {
	const name = checkName(input.name);
	const value = input.value === undefined || input.value === null ? '' : String(input.value);
	if (value.length > 8000) throw new Error('El valor va hasta 8000 caracteres.');
	const domains = normalizeDomains(input.domains);
	const exposeReal = input.exposeReal === true;
	if (!exposeReal && !domains.length)
		throw new Error('Indica a qué dominios va la key, o márcala «entregar el valor real».');
	const existing = await row<{ id: number }>('select id from person_keys where person_id = $1 and name = $2', [
		personId,
		name,
	]);
	if (!existing && !value) throw new Error('Falta el valor de la key.');
	if (
		!existing &&
		(await row<{ n: number }>('select count(*) as n from person_keys where person_id = $1', [personId]))!.n >= MAX_KEYS
	)
		throw new Error(`Hasta ${MAX_KEYS} API Keys por persona.`);
	if (existing)
		await exec(
			`update person_keys set domains = $2, expose_real = $3, value_enc = coalesce($4, value_enc), updated_at = now() where id = $1`,
			[existing.id, domains, exposeReal, value ? seal(value) : null],
		);
	else
		await exec(
			'insert into person_keys (person_id, name, value_enc, domains, expose_real) values ($1, $2, $3, $4, $5)',
			[personId, name, seal(value), domains, exposeReal],
		);
	return listKeys(personId);
}

export async function removeKey(personId: number, id: number) {
	await exec('delete from person_keys where id = $1 and person_id = $2', [id, personId]);
	return listKeys(personId);
}

/** Replaces the agents a key is granted to; only the person's own live agents count. */
export async function grantKey(personId: number, id: number, agentIds: unknown) {
	await tx(async (c) => {
		if (!(await row('select 1 from person_keys where id = $1 and person_id = $2 for update', [id, personId], c)))
			throw new Error('No existe.');
		await exec('delete from person_key_grants where key_id = $1', [id], c);
		await exec(
			`insert into person_key_grants (key_id, agent_id)
			 select $1, a.id from agents a where a.person_id = $2 and a.deleted_at is null and a.id = any($3::bigint[])`,
			[id, personId, ids(agentIds)],
			c,
		);
	});
	return listKeys(personId);
}

const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);

// ---------- MCP servers ----------

function viewPairs(list: Pair[]) {
	return list.map((p) => ({ name: p.name, secret: p.secret, value: p.secret ? null : (p.value ?? '') }));
}

export async function listMcp(personId: number): Promise<McpView[]> {
	const all = await rows<Omit<McpView, 'headers' | 'env'> & { headers: Pair[]; env: Pair[] }>(
		`select m.id, m.name, m.description, m.transport, m.url, m.command, m.args, m.headers, m.env, m.domains,
		        m.expose_real, m.oauth, m.updated_at,
		        coalesce(array_agg(g.agent_id::int order by g.agent_id) filter (where g.agent_id is not null), '{}') as agents
		 from person_mcp m left join person_mcp_grants g on g.mcp_id = m.id
		 where m.person_id = $1 group by m.id order by m.name`,
		[personId],
	);
	return all.map((m) => ({ ...m, headers: viewPairs(m.headers), env: viewPairs(m.env) }));
}

type PairInput = { name?: unknown; value?: unknown; secret?: unknown };

/** Pairs from the form: a secret without a value keeps the stored one (by name). */
function sealPairs(input: unknown, previous: Pair[], label: string): Pair[] {
	const list = Array.isArray(input) ? (input as PairInput[]) : [];
	if (list.length > 20) throw new Error(`Hasta 20 ${label}.`);
	return list.map((p) => {
		const name = String(p.name ?? '').trim();
		const value = p.value === undefined || p.value === null ? '' : String(p.value);
		const secret = p.secret === true;
		if (!name) throw new Error(`Falta el nombre de uno de los ${label}.`);
		if (value.length > 8000) throw new Error(`Un valor de ${label} pasa de 8000 caracteres.`);
		if (!secret) return { name, secret, value };
		const kept = previous.find((q) => q.name === name && q.secret)?.value_enc;
		if (!value && !kept) throw new Error(`Falta el valor secreto de ${name}.`);
		return { name, secret, value_enc: value ? seal(value) : kept };
	});
}

/** Creates or replaces a person's MCP server by its name. */
export async function saveMcp(personId: number, input: Record<string, unknown>) {
	const transport = input.transport === 'stdio' ? 'stdio' : 'http';
	const name = String(input.name ?? '').trim();
	const before = await row<{ id: number; headers: Pair[]; env: Pair[] }>(
		'select id, headers, env from person_mcp where person_id = $1 and name = $2',
		[personId, name],
	);
	const headers = transport === 'http' ? sealPairs(input.headers, before?.headers ?? [], 'encabezados') : [];
	const env = transport === 'stdio' ? sealPairs(input.env, before?.env ?? [], 'variables') : [];
	// The harness' own rules (slug, URL, command without a path, OAuth or a token): one source of truth.
	let server: McpServer;
	try {
		server = validateMcpServer({
			name,
			description: String(input.description ?? ''),
			transport,
			url: transport === 'http' ? String(input.url ?? '') : null,
			command: transport === 'stdio' ? String(input.command ?? '') : null,
			args: transport === 'stdio' && Array.isArray(input.args) ? input.args.map(String) : [],
			headers: headers.map((h) => ({ name: h.name, value: 'x' })),
			env: env.map((e) => ({ name: e.name, value: 'x' })),
			oauth: input.oauth === true,
		});
	} catch (err) {
		throw new Error((err as Error).message.replace(/^Harness: /, ''));
	}
	const exposeReal = input.exposeReal === true;
	const domains =
		transport === 'http' ? [new URL(server.url!).hostname.toLowerCase()] : normalizeDomains(input.domains);
	if (transport === 'stdio' && env.some((e) => e.secret) && !exposeReal && !domains.length)
		throw new Error(
			'Un MCP local con variables secretas necesita los dominios a los que llama, o «entregar el valor real».',
		);
	if (
		!before &&
		(await row<{ n: number }>('select count(*) as n from person_mcp where person_id = $1', [personId]))!.n >= MAX_MCP
	)
		throw new Error(`Hasta ${MAX_MCP} servidores MCP por persona.`);
	const values = [
		server.description,
		server.transport,
		server.url,
		server.command,
		JSON.stringify(server.args),
		JSON.stringify(headers),
		JSON.stringify(env),
		domains,
		exposeReal,
		server.oauth,
	];
	if (before)
		await exec(
			`update person_mcp set description = $2, transport = $3, url = $4, command = $5, args = $6, headers = $7,
			   env = $8, domains = $9, expose_real = $10, oauth = $11, updated_at = now() where id = $1`,
			[before.id, ...values],
		);
	else
		await exec(
			`insert into person_mcp (person_id, name, description, transport, url, command, args, headers, env, domains, expose_real, oauth)
			 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
			[personId, server.name, ...values],
		);
	return listMcp(personId);
}

/** Agents that lose a granted MCP server get signed out of it at their next run (Q6). */
async function logoutLost(c: Exec, server: string, agentIds: number[]) {
	if (agentIds.length)
		await exec(
			'insert into mcp_logouts (agent_id, server) select a, $2 from unnest($1::bigint[]) a',
			[agentIds, server],
			c,
		);
}

export async function removeMcp(personId: number, id: number) {
	await tx(async (c) => {
		const m = await row<{ name: string }>(
			'select name from person_mcp where id = $1 and person_id = $2 for update',
			[id, personId],
			c,
		);
		if (!m) return;
		const had = await rows<{ agent_id: number }>('select agent_id from person_mcp_grants where mcp_id = $1', [id], c);
		await logoutLost(
			c,
			m.name,
			had.map((g) => g.agent_id),
		);
		await exec('delete from person_mcp where id = $1', [id], c);
	});
	return listMcp(personId);
}

export async function grantMcp(personId: number, id: number, agentIds: unknown) {
	await tx(async (c) => {
		const m = await row<{ name: string }>(
			'select name from person_mcp where id = $1 and person_id = $2 for update',
			[id, personId],
			c,
		);
		if (!m) throw new Error('No existe.');
		const before = (
			await rows<{ agent_id: number }>('select agent_id from person_mcp_grants where mcp_id = $1', [id], c)
		).map((g) => g.agent_id);
		await exec('delete from person_mcp_grants where mcp_id = $1', [id], c);
		await exec(
			`insert into person_mcp_grants (mcp_id, agent_id)
			 select $1, a.id from agents a where a.person_id = $2 and a.deleted_at is null and a.id = any($3::bigint[])`,
			[id, personId, ids(agentIds)],
			c,
		);
		const after = new Set(
			(await rows<{ agent_id: number }>('select agent_id from person_mcp_grants where mcp_id = $1', [id], c)).map(
				(g) => g.agent_id,
			),
		);
		await logoutLost(
			c,
			m.name,
			before.filter((a) => !after.has(a)),
		);
	});
	return listMcp(personId);
}

/** Servers to sign out of at this run's start; marked done when the supervisor reports it. */
export const pendingLogouts = (agentId: number) =>
	rows<{ id: number; server: string }>('select id, server from mcp_logouts where agent_id = $1 and done_at is null', [
		agentId,
	]);
export async function logoutsDone(agentId: number, idsDone: unknown) {
	await exec('update mcp_logouts set done_at = now() where agent_id = $1 and id = any($2::bigint[])', [
		agentId,
		ids(idsDone),
	]);
}

// ---------- what a run gets ----------

/** What an agent was granted, by name: for its prompt and its settings (never values). */
export async function grantedTo(agentId: number) {
	const keys = await rows<{ name: string; domains: string[]; expose_real: boolean }>(
		`select k.name, k.domains, k.expose_real from person_keys k join person_key_grants g on g.key_id = k.id
		 join agents a on a.id = g.agent_id and a.person_id = k.person_id
		 where g.agent_id = $1 order by k.name`,
		[agentId],
	);
	const mcp = await rows<{ name: string; description: string }>(
		`select m.name, m.description from person_mcp m join person_mcp_grants g on g.mcp_id = m.id
		 join agents a on a.id = g.agent_id and a.person_id = m.person_id
		 where g.agent_id = $1 order by m.name`,
		[agentId],
	);
	return { keys, mcp };
}

/** A granted MCP server of the agent that signs in with OAuth (for its browser sign-in). */
export const grantedOauth = (agentId: number, name: string) =>
	row<{ name: string }>(
		`select m.name from person_mcp m join person_mcp_grants g on g.mcp_id = m.id
		 join agents a on a.id = g.agent_id and a.person_id = m.person_id
		 where g.agent_id = $1 and m.name = $2 and m.oauth`,
		[agentId, name],
	);

type Rule = { domains: string[]; placeholder: string; value: string };

/**
 * For a run's start (proxyToken: its new credential towards the proxy, null without a proxy): the
 * variables of its granted keys and its granted MCP servers, secrets as placeholders. An agent's
 * own secret (agent_secrets) with the same name wins (Q11/Q18).
 */
export async function forRun(agentId: number, proxyToken: string | null, own: Record<string, string>) {
	const { env, servers } = await resolve(agentId, proxyToken);
	return { env: { ...env, ...own }, grantedMcp: servers };
}

async function resolve(agentId: number, proxyToken: string | null) {
	const keys = await rows<{ id: number; name: string; value_enc: string; domains: string[]; expose_real: boolean }>(
		`select k.id, k.name, k.value_enc, k.domains, k.expose_real from person_keys k
		 join person_key_grants g on g.key_id = k.id join agents a on a.id = g.agent_id and a.person_id = k.person_id
		 where g.agent_id = $1`,
		[agentId],
	);
	const mcps = await rows<{
		id: number;
		name: string;
		description: string;
		transport: 'http' | 'stdio';
		url: string | null;
		command: string | null;
		args: string[];
		headers: Pair[];
		env: Pair[];
		domains: string[];
		expose_real: boolean;
		oauth: boolean;
	}>(
		`select m.* from person_mcp m join person_mcp_grants g on g.mcp_id = m.id
		 join agents a on a.id = g.agent_id and a.person_id = m.person_id where g.agent_id = $1 order by m.name`,
		[agentId],
	);
	const env: Record<string, string> = {};
	const rules: Rule[] = [];
	// Without a proxy a placeholder would reach nobody: such a key is simply not delivered.
	const secretOf = (field: string, valueEnc: string, domains: string[], exposeReal: boolean) => {
		const value = open(valueEnc);
		if (exposeReal) return value;
		if (!proxyToken) return null;
		const p = placeholder(proxyToken, field);
		rules.push({ domains, placeholder: p, value });
		return p;
	};
	for (const k of keys) {
		const v = secretOf(`key:${k.id}`, k.value_enc, k.domains, k.expose_real);
		if (v !== null) env[k.name] = v;
	}
	const servers: McpServer[] = [];
	for (const m of mcps) {
		const pairs = (list: Pair[], kind: 'h' | 'e') =>
			list.flatMap((p) => {
				if (!p.secret) return [{ name: p.name, value: p.value ?? '' }];
				const v = secretOf(`mcp:${m.id}:${kind}:${p.name}`, p.value_enc!, m.domains, m.expose_real);
				return v === null ? [] : [{ name: p.name, value: v }];
			});
		servers.push({
			name: m.name,
			description: m.description,
			transport: m.transport,
			url: m.url,
			command: m.command,
			args: m.args,
			headers: pairs(m.headers, 'h'),
			env: pairs(m.env, 'e'),
			oauth: m.oauth,
		});
	}
	return { env, servers, rules };
}

// ---------- the egress proxy's side ----------

/** A run's new credential towards the proxy (its hash stored on the run). */
export async function issueProxyToken(runId: number, on?: Exec) {
	const token = randomBytes(24).toString('base64url');
	await exec('update runs set proxy_token_hash = $2 where id = $1', [runId, hash(token)], on);
	return token;
}

/** The proxy asks: which placeholders to swap, and towards which domains, for this live run. */
export async function rulesFor(proxyToken: string) {
	const run = await row<{ agent_id: number }>(
		`select agent_id from runs where proxy_token_hash = $1 and status in ('starting', 'running', 'blocked')`,
		[hash(proxyToken)],
	);
	if (!run) return null;
	return (await resolve(run.agent_id, proxyToken)).rules;
}

/** Settings for the run's sandbox, or null when this instance has no egress proxy configured. */
export function proxyConfig() {
	const url = process.env.AGENTS_PROXY_URL,
		// Production: base64, one line in the stack's Environment; dev: the PEM itself.
		b64 = process.env.AGENTS_PROXY_CA_CERT_B64,
		ca = process.env.AGENTS_PROXY_CA_CERT || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
	return url && ca ? { url, ca } : null;
}

export const proxySecretOk = (given: string | undefined) => {
	const want = process.env.AGENTS_PROXY_SECRET;
	return !!want && !!given && given.length === want.length && hash(given).equals(hash(want));
};

/** http://run:<token>@proxy:8080 */
export function proxyUrlFor(token: string) {
	const cfg = proxyConfig();
	if (!cfg) return null;
	const u = new URL(cfg.url);
	u.username = 'run';
	u.password = token;
	return u.href.replace(/\/$/, '');
}

// ---------- migrating each agent's secrets (Q13, Q18, Q19) ----------

/**
 * agent_secrets -> the person's keys, granted to the agents that had them, as «entregar el valor
 * real» (they have no domains yet). A name whose values differ between two of the person's agents is
 * a conflict: it stays on each agent (it wins there) until the person picks one. Idempotent.
 */
export async function migrateAgentSecrets() {
	const all = await rows<{ person_id: number; agent_id: number; name: string; value_enc: string }>(
		`select a.person_id, s.agent_id, s.name, s.value_enc from agent_secrets s join agents a on a.id = s.agent_id
		 where a.deleted_at is null order by a.person_id, s.name, s.agent_id`,
	);
	const groups = new Map<string, typeof all>();
	for (const s of all) {
		const k = `${s.person_id}\u0000${s.name}`;
		groups.set(k, [...(groups.get(k) ?? []), s]);
	}
	let migrated = 0,
		conflicts = 0;
	for (const list of groups.values()) {
		const { person_id, name } = list[0];
		const values = new Set(list.map((s) => open(s.value_enc)));
		const existing = await row<{ id: number; value_enc: string }>(
			'select id, value_enc from person_keys where person_id = $1 and name = $2',
			[person_id, name],
		);
		if (values.size > 1 || (existing && !values.has(open(existing.value_enc)))) {
			conflicts++;
			continue;
		}
		await tx(async (c) => {
			const id =
				existing?.id ??
				(await row<{ id: number }>(
					`insert into person_keys (person_id, name, value_enc, expose_real) values ($1, $2, $3, true) returning id`,
					[person_id, name, list[0].value_enc],
					c,
				))!.id;
			await exec(
				`insert into person_key_grants (key_id, agent_id) select $1, unnest($2::bigint[]) on conflict do nothing`,
				[id, list.map((s) => s.agent_id)],
				c,
			);
			await exec(
				'delete from agent_secrets where agent_id = any($1::bigint[]) and name = $2',
				[list.map((s) => s.agent_id), name],
				c,
			);
		});
		migrated++;
	}
	return { migrated, conflicts };
}

/** An agent's leftovers after the migration: the names to resolve (values never shown). */
export const conflictsOf = (agentId: number) =>
	rows<{ name: string; updated_at: number }>(
		'select name, updated_at from agent_secrets where agent_id = $1 order by name',
		[agentId],
	);

/**
 * The person picks which agent's value becomes theirs for that name: it becomes (or replaces) their
 * key, granted to every agent that had the name; those agents' own copies go.
 */
export async function resolveConflict(personId: number, name: unknown, fromAgentId: number) {
	const n = checkName(name);
	await tx(async (c) => {
		const owned = await rows<{ agent_id: number; value_enc: string }>(
			`select s.agent_id, s.value_enc from agent_secrets s join agents a on a.id = s.agent_id
			 where a.person_id = $1 and s.name = $2 for update`,
			[personId, n],
			c,
		);
		const pick = owned.find((s) => s.agent_id === fromAgentId);
		if (!pick) throw new Error('Ese agente no tiene esa variable.');
		const key = await row<{ id: number }>(
			`insert into person_keys (person_id, name, value_enc, expose_real) values ($1, $2, $3, true)
			 on conflict (person_id, name) do update set value_enc = excluded.value_enc, updated_at = now() returning id`,
			[personId, n, pick.value_enc],
			c,
		);
		await exec(
			'insert into person_key_grants (key_id, agent_id) select $1, unnest($2::bigint[]) on conflict do nothing',
			[key!.id, owned.map((s) => s.agent_id)],
			c,
		);
		await exec(
			'delete from agent_secrets where agent_id = any($1::bigint[]) and name = $2',
			[owned.map((s) => s.agent_id), n],
			c,
		);
	});
}

// ---------- «Probar» an MCP server over HTTP (from the backend, with its real headers) ----------

async function rpc(url: string, headers: Record<string, string>, body: unknown) {
	const res = await fetch(url, {
		method: 'POST',
		redirect: 'manual',
		signal: AbortSignal.timeout(10_000),
		headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify(body),
	});
	if (res.status === 401 || res.status === 403) throw new Error('El servidor rechazó las credenciales.');
	if (!res.ok && res.status !== 202) throw new Error(`El servidor respondió ${res.status}.`);
	const text = await res.text();
	// Streamable HTTP answers with JSON or with server-sent events; the result is in a `data:` line.
	const json = res.headers.get('content-type')?.includes('text/event-stream')
		? text
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trim())
				.find((l) => l.startsWith('{'))
		: text;
	return { session: res.headers.get('mcp-session-id'), data: json ? JSON.parse(json) : null };
}

/** Lists a person's HTTP MCP server's tools: connection, credentials and protocol in one check. */
export async function testMcp(personId: number, id: number) {
	const m = await row<{ transport: string; url: string | null; headers: Pair[]; oauth: boolean }>(
		'select transport, url, headers, oauth from person_mcp where id = $1 and person_id = $2',
		[id, personId],
	);
	if (!m) throw new Error('No existe.');
	if (m.transport !== 'http') throw new Error('Un MCP local se comprueba en la primera tarea del agente.');
	if (m.oauth) throw new Error('Este MCP usa OAuth: se comprueba al iniciar sesión desde un agente.');
	const headers = Object.fromEntries(m.headers.map((h) => [h.name, h.secret ? open(h.value_enc!) : (h.value ?? '')]));
	try {
		const init = await rpc(m.url!, headers, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agents', version: '1' } },
		});
		if (init.data?.error) throw new Error(String(init.data.error.message ?? 'initialize falló'));
		const session: Record<string, string> = init.session ? { 'mcp-session-id': init.session } : {};
		await rpc(m.url!, { ...headers, ...session }, { jsonrpc: '2.0', method: 'notifications/initialized' });
		const list = await rpc(m.url!, { ...headers, ...session }, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const tools = Array.isArray(list.data?.result?.tools)
			? list.data.result.tools.map((t: { name: string }) => String(t.name))
			: [];
		return { ok: true, tools: tools.slice(0, 100) };
	} catch (err) {
		const e = err as Error;
		throw new Error(
			e.name === 'TimeoutError' ? 'El servidor no respondió en 10 s.' : `No se pudo probar: ${e.message}`,
		);
	}
}
