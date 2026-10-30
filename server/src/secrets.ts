// An agent's credentials for its CLI tools and MCP servers: sealed at rest, never shown again after
// saving, and handed only to that agent's sandbox as environment variables (pi, its shell and the
// MCP servers, which reference them as ${NAME}). The agent can read them: a known, accepted tradeoff.
import { row, rows, exec } from './db';
import { seal, open } from './crypto';

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// The sandbox's own variables: a credential never replaces them.
const RESERVED = new Set([
	'PATH',
	'HOME',
	'USER',
	'SHELL',
	'LANG',
	'TZ',
	'TERM',
	'BROWSER',
	'DISPLAY',
	'XAUTHORITY',
	'OPENAI_API_KEY',
	'NODE_OPTIONS',
]);
const RESERVED_PREFIX = ['AGENTS_', 'AGENT_BROWSER_', 'PI_', 'LD_', 'NODE_', 'NPM_', 'UV_'];

export function checkName(raw: unknown) {
	const name = String(raw ?? '')
		.trim()
		.toUpperCase();
	if (!NAME.test(name))
		throw new Error('El nombre va en mayúsculas, con letras, números y _ (por ejemplo GITHUB_TOKEN).');
	if (RESERVED.has(name) || RESERVED_PREFIX.some((p) => name.startsWith(p)))
		throw new Error(`${name} es una variable de la plataforma; usa otro nombre.`);
	return name;
}

export const list = (agentId: number) =>
	rows<{ name: string; updated_at: number }>(
		'select name, updated_at from agent_secrets where agent_id = $1 order by name',
		[agentId],
	);

export async function set(agentId: number, rawName: unknown, value: unknown) {
	const name = checkName(rawName);
	const v = String(value ?? '');
	if (!v || v.length > 8000) throw new Error('El valor va de 1 a 8000 caracteres.');
	if (
		(await row<{ n: number }>('select count(*) as n from agent_secrets where agent_id = $1 and name <> $2', [
			agentId,
			name,
		]))!.n >= 30
	)
		throw new Error('Hasta 30 credenciales por agente.');
	await exec(
		`insert into agent_secrets (agent_id, name, value_enc) values ($1, $2, $3)
		 on conflict (agent_id, name) do update set value_enc = excluded.value_enc, updated_at = now()`,
		[agentId, name, seal(v)],
	);
	return list(agentId);
}

export async function remove(agentId: number, rawName: unknown) {
	await exec('delete from agent_secrets where agent_id = $1 and name = $2', [agentId, String(rawName ?? '')]);
	return list(agentId);
}

/** Only for the agent's own sandbox start. */
export async function forRun(agentId: number) {
	const all = await rows<{ name: string; value_enc: string }>(
		'select name, value_enc from agent_secrets where agent_id = $1',
		[agentId],
	);
	return Object.fromEntries(all.map((s) => [s.name, open(s.value_enc)]));
}
