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
