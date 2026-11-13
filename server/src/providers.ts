// Each person's provider keys and the CLIProxyAPI config built from them.
//
// CLIProxyAPI can't bind a client key to an upstream account, so this backend is the only client
// it has (one internal key, AGENTS_PROXY_KEY) and each person's keys live under the prefix u<id>.
// With routing.force-model-prefix, "u7/gpt-6.1-sol" can only use person 7's key.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { row, rows, exec } from './db';
import { seal, open } from './crypto';

// GPT only (no Claude in Agents): OpenAI is the one provider.
export type Provider = 'openai';
export const PROVIDERS: Provider[] = ['openai'];

const CONFIG = process.env.AGENTS_CLIPROXY_CONFIG ?? 'data/cliproxy/config.yaml';

export const prefixOf = (personId: number) => `u${personId}`;

export function keysOf(personId: number) {
	return rows<{ provider: Provider; last4: string; updated_at: number }>(
		'select provider, last4, updated_at from provider_keys where person_id = $1',
		[personId],
	);
}

export async function hasKey(personId: number, provider: Provider) {
	return Boolean(await row('select 1 from provider_keys where person_id = $1 and provider = $2', [personId, provider]));
}

export async function setKey(personId: number, provider: Provider, key: string) {
	const k = key.trim();
	await exec(
		`insert into provider_keys (person_id, provider, key_enc, last4) values ($1, $2, $3, $4)
		 on conflict (person_id, provider) do update set key_enc = excluded.key_enc, last4 = excluded.last4, updated_at = now()`,
		[personId, provider, seal(k), k.slice(-4)],
	);
	await writeProxyConfig();
}

export async function deleteKey(personId: number, provider: Provider) {
	await exec('delete from provider_keys where person_id = $1 and provider = $2', [personId, provider]);
	await writeProxyConfig();
}

// ---------- a person's own CLIProxyAPI ----------

export function proxyOf(personId: number) {
	return row<{ url: string; last4: string; updated_at: number }>(
		'select url, last4, updated_at from proxy_accounts where person_id = $1',
		[personId],
	);
}

/** URL and key, decrypted: only for the LLM gateway. */
export async function proxyCredentials(personId: number) {
	const r = await row<{ url: string; key_enc: string }>(
		'select url, key_enc from proxy_accounts where person_id = $1',
		[personId],
	);
	return r ? { url: r.url, key: open(r.key_enc) } : null;
}

/** https://host:8317/v1/ -> https://host:8317 */
export function normalizeProxyUrl(raw: string) {
	const u = new URL(String(raw ?? '').trim());
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('La URL debe empezar con http:// o https://');
	return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
}

/** The proxy did not answer (network, timeout, 5xx, 429): the same request may work in a while. */
export class ProxyUnreachable extends Error {}

/** The model ids the proxy serves with this key; throws a readable error otherwise. */
export async function proxyModels(url: string, key: string) {
	let res: Response;
	try {
		res = await fetch(`${url}/v1/models`, {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(8000),
		});
	} catch (err) {
		throw new ProxyUnreachable(`No se pudo conectar a ${url} desde el servidor: ${(err as Error).message}`);
	}
	if (res.status === 401 || res.status === 403) throw new Error('El proxy rechazó la API key.');
	if (res.status >= 500 || res.status === 429)
		throw new ProxyUnreachable(`El proxy respondió ${res.status} en /v1/models.`);
	if (!res.ok) throw new Error(`El proxy respondió ${res.status} en /v1/models.`);
	const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
	if (!Array.isArray(data?.data)) throw new Error('Eso no parece un CLIProxyAPI (/v1/models no devolvió una lista).');
	return data.data.map((m) => m.id);
}

/** Fail before allocating a sandbox when the person's proxy does not advertise the model. */
export async function checkProxyModel(personId: number, model: string) {
	const own = await proxyCredentials(personId);
	if (!own) return;
	const id = model.split('/', 2)[1];
	const ids = await proxyModels(own.url, own.key);
	if (ids.includes(id)) return;
	const alternatives = ids.filter((m) => m.startsWith('gpt-')).slice(0, 8);
	throw new Error(
		`Tu CLIProxyAPI no ofrece ${id}. Cambia el modelo del agente.${alternatives.length ? ` Disponibles: ${alternatives.join(', ')}.` : ''}`,
	);
}

export async function setProxy(personId: number, url: string, key: string) {
	await exec(
		`insert into proxy_accounts (person_id, url, key_enc, last4) values ($1, $2, $3, $4)
		 on conflict (person_id) do update set url = excluded.url, key_enc = excluded.key_enc, last4 = excluded.last4, updated_at = now()`,
		[personId, url, seal(key), key.slice(-4)],
	);
}

export async function deleteProxy(personId: number) {
	await exec('delete from proxy_accounts where person_id = $1', [personId]);
}

/** Rewrites CLIProxyAPI's config; it reloads the file on its own. */
export async function writeProxyConfig() {
	const proxyKey = process.env.AGENTS_PROXY_KEY;
	if (!proxyKey) throw new Error('AGENTS_PROXY_KEY is not set');
	const keys = await rows<{ person_id: number; key_enc: string }>(
		"select person_id, key_enc from provider_keys where provider = 'openai' order by person_id",
	);
	const codex = keys.map((r) => ({
		name: `${prefixOf(r.person_id)}-openai`,
		prefix: prefixOf(r.person_id),
		'base-url': 'https://api.openai.com/v1',
		'request-retry': 0,
		keys: [{ 'api-key': open(r.key_enc), 'disable-codex-cloaking': true }],
	}));
	const config: Record<string, unknown> = {
		'config-version': 8,
		server: { host: '', port: 8317 },
		management: { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true },
		access: { 'api-keys': [proxyKey] },
		routing: { strategy: 'fill-first', 'force-model-prefix': true },
		'usage-statistics-enabled': false,
	};
	if (codex.length) config['api-keys'] = { codex };
	mkdirSync(dirname(CONFIG), { recursive: true });
	// Written in place, not renamed over: CLIProxyAPI's watcher follows the file and misses a rename.
	const text =
		'# Written by the Agents backend. Do not edit: it is rewritten on every key change.\n' + YAML.stringify(config);
	if (existsSync(CONFIG) && readFileSync(CONFIG, 'utf8') === text) return;
	writeFileSync(CONFIG, text, { mode: 0o600 });
}
