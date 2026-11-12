// What the designer can look up during the interview (#26): the official MCP registry, npm (CLIs) and
// skills.sh (skills). Read only, bounded and cached; results are data for the model and cards for the
// owner, never instructions. The owner decides what is added; secrets never go through the model.

/** A value the owner fills in when adding an MCP server: a header (http) or a variable (stdio). */
export type FindingField = {
	name: string;
	description: string;
	secret: boolean;
	target: 'header' | 'env';
	/** How the value is written, e.g. «Bearer {token}»; null: the value as typed. */
	template: string | null;
	/** Non-secret values the registry already gives. */
	value: string | null;
};
export type Finding = {
	id: string; // kind:name, stable within a draft
	kind: 'mcp' | 'cli' | 'skill';
	name: string;
	title: string;
	description: string;
	version: string | null;
	url: string | null;
	fields: FindingField[];
	/** MCP: how it runs. */
	mcp?: { transport: 'http'; url: string; oauth: boolean } | { transport: 'stdio'; command: string; args: string[] };
	/** skill: where its SKILL.md lives (owner/repo and the skill's id). */
	skill?: { repo: string; skillId: string };
	/** What the owner decided on its card. */
	status?: 'pending' | 'added' | 'skipped';
	/** Once added: the access it became (mcp) or the skill imported into the harness. */
	added?: {
		access?: string;
		skill?: string;
		source?: string;
		/** The imported skill itself: kept in the harness through later replies. */
		imported?: { name: string; description: string; instructions: string };
	};
};
export type Search = { tool: string; query: string; results: number; error?: string };

const TIMEOUT = 8000;
const cache = new Map<string, { at: number; value: Finding[] }>();
async function cached(key: string, load: () => Promise<Finding[]>) {
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
	const value = await load();
	cache.set(key, { at: Date.now(), value });
	if (cache.size > 200) cache.delete(cache.keys().next().value!);
	return value;
}
async function json(url: string) {
	const r = await fetch(url, {
		signal: AbortSignal.timeout(TIMEOUT),
		headers: { accept: 'application/json', 'user-agent': 'cuby-agents-designer' },
	});
	if (!r.ok) throw new Error(`${new URL(url).hostname} respondió ${r.status}`);
	return r.json() as Promise<any>;
}
const clip = (s: unknown, n: number) =>
	String(s ?? '')
		.trim()
		.slice(0, n);
/** A registry name as an MCP server name: slug, up to 31 characters. */
export const mcpSlug = (name: string) =>
	(
		name
			.split('/')
			.at(-1)!
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^[^a-z]+/, '')
			.replace(/-+/g, '-')
			.replace(/-$/, '') || 'mcp'
	).slice(0, 31);

/** The official MCP registry: the latest version of each server, with what it needs. */
export function searchMcp(query: string) {
	return cached(`mcp:${query}`, async () => {
		const d = await json(
			`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(query)}&limit=30`,
		);
		const seen = new Set<string>();
		const out: Finding[] = [];
		for (const item of d.servers ?? []) {
			const s = item.server ?? item;
			const latest = item._meta?.['io.modelcontextprotocol.registry/official']?.isLatest;
			if (!s?.name || seen.has(s.name) || latest === false) continue;
			const finding = mcpFinding(s);
			if (!finding) continue;
			seen.add(s.name);
			out.push(finding);
			if (out.length >= 6) break;
		}
		return out;
	});
}
function mcpFinding(s: any): Finding | null {
	const base = {
		id: `mcp:${s.name}`,
		kind: 'mcp' as const,
		name: s.name,
		title: clip(s.title || s.name.split('/').at(-1), 80),
		description: clip(s.description, 300),
		version: s.version ? clip(s.version, 40) : null,
		url: s.repository?.url ?? s.websiteUrl ?? null,
	};
	const remote = (s.remotes ?? []).find((r: any) => ['streamable-http', 'sse'].includes(r?.type) && r.url);
	if (remote && /^https:\/\//.test(remote.url)) {
		const fields = (remote.headers ?? []).map((h: any): FindingField => ({
			name: clip(h.name, 100),
			description: clip(h.description, 300),
			secret: !!h.isSecret,
			target: 'header',
			template: typeof h.value === 'string' && /\{[^}]+\}/.test(h.value) ? h.value : null,
			value: !h.isSecret && typeof h.value === 'string' && !/\{[^}]+\}/.test(h.value) ? h.value : null,
		}));
		// A remote that asks for no header signs in some other way: OAuth (the owner signs in later).
		return { ...base, fields, mcp: { transport: 'http', url: remote.url, oauth: !fields.length } };
	}
	const pkg = (s.packages ?? []).find(
		(p: any) => ['npm', 'pypi'].includes(p?.registryType) && p.identifier && p.version && p.transport?.type !== 'sse',
	);
	if (!pkg) return null;
	const npm = pkg.registryType === 'npm';
	const fields = (pkg.environmentVariables ?? [])
		.filter((e: any) => e?.name && (e.isRequired || e.isSecret))
		.map((e: any): FindingField => ({
			name: clip(e.name, 100),
			description: clip(e.description, 300),
			secret: !!e.isSecret,
			target: 'env',
			template: null,
			value: !e.isSecret && e.default != null ? String(e.default) : null,
		}));
	return {
		...base,
		version: clip(pkg.version, 40),
		fields,
		mcp: npm
			? // `npx` is Bun's bunx in computers on Bun, and Node's in older images: both run it.
				{ transport: 'stdio', command: 'npx', args: ['-y', `${pkg.identifier}@${pkg.version}`] }
			: { transport: 'stdio', command: 'uvx', args: [`${pkg.identifier}==${pkg.version}`] },
	};
}

/** npm: command-line tools to install with a fixed version. */
export function searchCli(query: string) {
	return cached(`cli:${query}`, async () => {
		const d = await json(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=6`);
		return (d.objects ?? []).map((o: any): Finding => {
			const p = o.package;
			return {
				id: `cli:${p.name}`,
				kind: 'cli',
				name: p.name,
				title: clip(p.name, 80),
				description: clip(p.description, 300),
				version: p.version ? clip(p.version, 40) : null,
				url: p.links?.repository ?? p.links?.npm ?? null,
				fields: [],
			};
		});
	});
}

/** skills.sh: published skills (SKILL.md in a GitHub repository). */
export function searchSkills(query: string) {
	return cached(`skill:${query}`, async () => {
		const d = await json(`https://skills.sh/api/search?q=${encodeURIComponent(query)}`);
		return (d.skills ?? [])
			.filter((s: any) => s?.source && s.skillId && /^[\w.-]+\/[\w.-]+$/.test(s.source))
			.slice(0, 6)
			.map((s: any): Finding => ({
				id: `skill:${s.source}/${s.skillId}`,
				kind: 'skill',
				name: clip(s.skillId, 100),
				title: clip(s.name ?? s.skillId, 80),
				description: `${s.source}${s.installs ? ` · ${Number(s.installs).toLocaleString('es-MX')} instalaciones` : ''}`,
				version: null,
				url: `https://skills.sh/${s.source}/${s.skillId}`,
				fields: [],
				skill: { repo: s.source, skillId: s.skillId },
			}));
	});
}

export const SEARCHES = {
	buscar_mcp: searchMcp,
	buscar_cli: searchCli,
	buscar_skills: searchSkills,
} as const;
export type SearchTool = keyof typeof SEARCHES;

/** The designer's tools (Responses API function tools). */
export const SEARCH_TOOLS = [
	{
		name: 'buscar_mcp',
		description:
			'Busca servidores MCP en el registro oficial (registry.modelcontextprotocol.io). Devuelve nombre, versión, cómo corre y qué encabezados o variables pide (y cuáles son secretos).',
	},
	{
		name: 'buscar_cli',
		description: 'Busca herramientas de línea de comandos en npm. Devuelve paquete, versión exacta y descripción.',
	},
	{
		name: 'buscar_skills',
		description:
			'Busca skills publicadas en skills.sh (un SKILL.md en un repositorio de GitHub). Devuelve id, repositorio e instalaciones.',
	},
].map((t) => ({
	type: 'function',
	name: t.name,
	description: t.description,
	strict: true,
	parameters: {
		type: 'object',
		additionalProperties: false,
		required: ['consulta'],
		properties: { consulta: { type: 'string', description: 'Pocas palabras en inglés: el servicio o la tarea.' } },
	},
}));

/** Imports a skill's SKILL.md as a harness skill, pinned to the repository's current commit. */
export async function importSkill(f: Finding) {
	if (!f.skill) throw new Error('No es una skill.');
	const { repo, skillId } = f.skill;
	const sha = (await json(`https://api.github.com/repos/${repo}/commits/HEAD`)).sha as string;
	if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('No se pudo fijar la versión de la skill.');
	let text: string | null = null,
		path = '';
	for (const p of [
		`skills/${skillId}/SKILL.md`,
		`${skillId}/SKILL.md`,
		`.claude/skills/${skillId}/SKILL.md`,
		'SKILL.md',
	]) {
		const r = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${p}`, {
			signal: AbortSignal.timeout(TIMEOUT),
		});
		if (r.ok) {
			text = await r.text();
			path = p;
			break;
		}
	}
	if (!text) throw new Error(`No encontré el SKILL.md de «${skillId}» en ${repo}.`);
	const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
	const meta = (key: string) =>
		fm?.[1]
			.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
			.trim()
			.replace(/^["']|["']$/g, '');
	const instructions = (fm ? text.slice(fm[0].length) : text).trim();
	if (instructions.length > 8000)
		throw new Error(
			`La skill «${skillId}» tiene ${instructions.length.toLocaleString('es-MX')} caracteres y el harness admite 8000. Pídele al diseñador una propia inspirada en ella.`,
		);
	const name = (meta('name') ?? skillId)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^[^a-z]+/, '')
		.slice(0, 40);
	return {
		skill: {
			name: name || 'skill',
			description: clip(meta('description') ?? f.title, 300),
			instructions,
		},
		source: `${repo}@${sha.slice(0, 7)}/${path}`,
	};
}
