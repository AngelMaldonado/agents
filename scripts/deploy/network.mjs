// Lecturas /v1/models, desde el namespace de red del backend de producción.
// No inferencia, mutaciones de configuración ni secretos en la salida.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/app/server/package.json');
const { Pool } = require('pg');
const { envValue } = await import('data:text/javascript;base64,' + process.env.AGENTS_BOOT_MODULE);
const { parseMasterKey, decrypt } = await import('data:text/javascript;base64,' + process.env.AGENTS_RESTORE_MODULE);
const key = parseMasterKey(fs.readFileSync('/run/production.env', 'utf8'));
// También comprobar presencia del PIN/proxy conservados; nunca exportarlos.
for (const name of ['AGENTS_ADMIN_PIN', 'AGENTS_PROXY_KEY'])
	envValue(fs.readFileSync('/run/production.env', 'utf8'), name);
const db = new Pool({
	host: '/socket',
	user: 'agents',
	database: 'agents_migration_recovery',
	options: '-c default_transaction_read_only=on -c statement_timeout=30s',
});
try {
	const result = [];
	for (const p of (await db.query('select person_id,url,key_enc from proxy_accounts order by person_id')).rows) {
		const expected = (
			await db.query('select id,model from agents where person_id=$1 and deleted_at is null', [p.person_id])
		).rows;
		try {
			const secret = decrypt(p.key_enc, key);
			const response = await fetch(p.url + '/v1/models', {
				headers: { authorization: 'Bearer ' + secret },
				signal: AbortSignal.timeout(8000),
				redirect: 'error',
			});
			const data = response.ok ? await response.json() : null;
			const ids = Array.isArray(data?.data) ? data.data.map((m) => m.id) : [];
			const missing = expected.filter((a) => !ids.includes(a.model.split('/')[1])).map((a) => Number(a.id));
			result.push({
				person: Number(p.person_id),
				status: response.status,
				ok: response.ok && ids.length > 0 && !missing.length,
				unavailableAgentModels: missing,
			});
		} catch {
			result.push({ person: Number(p.person_id), ok: false, error: 'unreachable-or-invalid-model-response' });
		}
	}
	console.log(
		JSON.stringify({
			ok: result.every((r) => r.ok),
			proxies: result,
			inferenceRequests: 0,
			secretsExported: false,
			networkNamespace: 'production-server',
		}),
	);
} finally {
	key.fill(0);
	await db.end();
}
