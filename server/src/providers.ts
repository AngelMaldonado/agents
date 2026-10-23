// Each person's provider keys and the CLIProxyAPI config built from them.
//
// CLIProxyAPI can't bind a client key to an upstream account, so this backend is the only client
// it has (one internal key, BUYER_PROXY_KEY) and each person's keys live under the prefix u<id>.
// With routing.force-model-prefix, "u7/claude-sonnet-4-6" can only use person 7's key.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { db, now } from './db';
import { seal, open } from './crypto';

export type Provider = 'anthropic' | 'openai';
export const PROVIDERS: Provider[] = ['anthropic', 'openai'];

const CONFIG = process.env.BUYER_CLIPROXY_CONFIG ?? 'data/cliproxy/config.yaml';

export const prefixOf = (personId: number) => `u${personId}`;

export function keysOf(personId: number) {
	return db
		.query('SELECT provider, last4, updated_at FROM provider_keys WHERE person_id = ?')
		.all(personId) as { provider: Provider; last4: string; updated_at: number }[];
}

export function hasKey(personId: number, provider: Provider) {
	return Boolean(db.query('SELECT 1 FROM provider_keys WHERE person_id = ? AND provider = ?').get(personId, provider));
}

export function setKey(personId: number, provider: Provider, key: string) {
	const k = key.trim();
	db.query(
		`INSERT INTO provider_keys (person_id, provider, enc, last4, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(person_id, provider) DO UPDATE SET enc = excluded.enc, last4 = excluded.last4, updated_at = excluded.updated_at`
	).run(personId, provider, seal(k), k.slice(-4), now());
	writeProxyConfig();
}

export function deleteKey(personId: number, provider: Provider) {
	db.query('DELETE FROM provider_keys WHERE person_id = ? AND provider = ?').run(personId, provider);
	writeProxyConfig();
}

// ---------- a person's own CLIProxyAPI ----------

export function proxyOf(personId: number) {
	return db.query('SELECT url, last4, updated_at FROM proxy_accounts WHERE person_id = ?').get(personId) as
		| { url: string; last4: string; updated_at: number }
		| null;
}

/** URL and key, decrypted: only for the LLM gateway. */
export function proxyCredentials(personId: number) {
	const row = db.query('SELECT url, enc_key FROM proxy_accounts WHERE person_id = ?').get(personId) as { url: string; enc_key: string } | null;
	return row ? { url: row.url, key: open(row.enc_key) } : null;
}

/** https://host:8317/v1/ -> https://host:8317 */
export function normalizeProxyUrl(raw: string) {
	const u = new URL(String(raw ?? '').trim());
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('La URL debe empezar con http:// o https://');
	return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
}

/** The model ids the proxy serves with this key; throws a readable error otherwise. */
export async function proxyModels(url: string, key: string) {
	let res: Response;
	try {
		res = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
	} catch (err) {
		throw new Error(`No se pudo conectar a ${url} desde el servidor: ${(err as Error).message}`);
	}
	if (res.status === 401 || res.status === 403) throw new Error('El proxy rechazó la API key.');
	if (!res.ok) throw new Error(`El proxy respondió ${res.status} en /v1/models.`);
	const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
	if (!Array.isArray(data?.data)) throw new Error('Eso no parece un CLIProxyAPI (/v1/models no devolvió una lista).');
	return data.data.map((m) => m.id);
}

/** Fail before allocating a sandbox when the person's proxy does not advertise the model. */
export async function checkProxyModel(personId: number, model: string) {
	const own = proxyCredentials(personId);
	if (!own) return;
	const [provider, id] = model.split('/', 2);
	const ids = await proxyModels(own.url, own.key);
	if (ids.includes(id)) return;
	const alternatives = ids.filter((m) => m.startsWith(provider === 'openai' ? 'gpt-' : 'claude-')).slice(0, 8);
	throw new Error(`Tu CLIProxyAPI no ofrece ${id}. Cambia el modelo del agente.${alternatives.length ? ` Disponibles: ${alternatives.join(', ')}.` : ''}`);
}

export function setProxy(personId: number, url: string, key: string) {
	db.query(
		`INSERT INTO proxy_accounts (person_id, url, enc_key, last4, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(person_id) DO UPDATE SET url = excluded.url, enc_key = excluded.enc_key, last4 = excluded.last4, updated_at = excluded.updated_at`
	).run(personId, url, seal(key), key.slice(-4), now());
}

export function deleteProxy(personId: number) {
	db.query('DELETE FROM proxy_accounts WHERE person_id = ?').run(personId);
}

/** Rewrites CLIProxyAPI's config; it reloads the file on its own. */
export function writeProxyConfig() {
	const proxyKey = process.env.BUYER_PROXY_KEY;
	if (!proxyKey) throw new Error('BUYER_PROXY_KEY is not set');
	const rows = db.query('SELECT person_id, provider, enc FROM provider_keys ORDER BY person_id').all() as {
		person_id: number;
		provider: Provider;
		enc: string;
	}[];
	const claude = rows
		.filter((r) => r.provider === 'anthropic')
		.map((r) => ({ name: `${prefixOf(r.person_id)}-claude`, prefix: prefixOf(r.person_id), 'request-retry': 0, keys: [{ 'api-key': open(r.enc) }] }));
	const codex = rows
		.filter((r) => r.provider === 'openai')
		.map((r) => ({
			name: `${prefixOf(r.person_id)}-openai`,
			prefix: prefixOf(r.person_id),
			'base-url': 'https://api.openai.com/v1',
			'request-retry': 0,
			keys: [{ 'api-key': open(r.enc), 'disable-codex-cloaking': true }]
		}));
	const config: Record<string, unknown> = {
		'config-version': 8,
		server: { host: '', port: 8317 },
		management: { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true },
		access: { 'api-keys': [proxyKey] },
		routing: { strategy: 'fill-first', 'force-model-prefix': true },
		'usage-statistics-enabled': false
	};
	const apiKeys: Record<string, unknown> = {};
	if (claude.length) apiKeys.claude = claude;
	if (codex.length) apiKeys.codex = codex;
	if (Object.keys(apiKeys).length) config['api-keys'] = apiKeys;
	mkdirSync(dirname(CONFIG), { recursive: true });
	// Written in place, not renamed over: CLIProxyAPI's watcher follows the file and misses a rename.
	const text = '# Written by the Buyer backend. Do not edit: it is rewritten on every key change.\n' + YAML.stringify(config);
	if (existsSync(CONFIG) && readFileSync(CONFIG, 'utf8') === text) return;
	writeFileSync(CONFIG, text, { mode: 0o600 });
}
