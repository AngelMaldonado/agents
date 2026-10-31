// Verificación privada del destino real: sin inferencia, login de personas ni exportación de secretos.
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
const require = createRequire('/app/server/package.json');
const { Pool } = require('pg');
const { decrypt, parseMasterKey } = await import('data:text/javascript;base64,' + process.env.AGENTS_RESTORE_MODULE);
const db = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, statement_timeout: 10000 });
const key = parseMasterKey('AGENTS_MASTER_KEY=' + process.env.AGENTS_MASTER_KEY);
const get = async (path, token) => {
	const response = await fetch('http://127.0.0.1:8787' + path, {
		headers: token ? { cookie: 'agents_session=' + token } : {},
		signal: AbortSignal.timeout(5000),
	});
	return { status: response.status, body: await response.json() };
};
try {
	if ((await db.query('select current_database() as name')).rows[0].name !== 'agents_beta1') throw Error('DB distinta');
	const health = await get('/healthz');
	if (!health.body.ready || health.body.sha !== 'f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3')
		throw Error('Release distinta');
	if ((await get('/api/agents')).status !== 401 || (await get('/api/admin/whatsapp')).status !== 404)
		throw Error('Guardas HTTP distintas');
	const people = (await db.query('select id,key from people order by id')).rows;
	if (people.length !== 7 || people.some((p) => p.key === 'test')) throw Error('Personas inesperadas');
	const angel = people.find((p) => p.key === 'angel');
	const angelk = people.find((p) => p.key === 'angelk');
	if (!angel || !angelk || Number(angel.id) === Number(angelk.id)) throw Error('Identidades fusionadas');
	const agents = (await db.query('select id,state_ref,deleted_at from agents order by id')).rows;
	if (JSON.stringify(agents.map((a) => Number(a.id))) !== JSON.stringify([10, 11, 12, 13, 14, 15, 16, 17, 18]))
		throw Error('Agentes inesperados');
	if (agents.some((a) => a.state_ref !== 'agents-prod-beta1-agent-' + a.id)) throw Error('Estado compartido');
	if (!agents.find((a) => Number(a.id) === 16)?.deleted_at) throw Error('Agente retirado reactivado');
	if (Number((await db.query("select count(*) as n from dbos.workflow_schedules where status<>'PAUSED'")).rows[0].n))
		throw Error('Cron no pausado durante aceptación');
	let fieldsDecrypted = 0;
	for (const [table, fields] of [
		['provider_keys', ['key_enc']],
		['proxy_accounts', ['key_enc']],
		['agent_webhooks', ['in_secret_enc', 'out_secret_enc']],
		['credentials', ['username_enc', 'password_enc', 'totp_enc']],
		['agent_secrets', ['value_enc']],
	]) {
		for (const row of (await db.query(`select ${fields.join(',')} from ${table}`)).rows)
			for (const field of fields)
				if (row[field]) {
					const plain = decrypt(row[field], key);
					plain.fill(0);
					fieldsDecrypted++;
				}
	}
	let peopleVisibilityChecked = 0;
	for (const person of people) {
		const token = randomBytes(32).toString('base64url');
		const hash = createHash('sha256').update(token).digest();
		await db.query('insert into sessions(token_hash,person_id) values($1,$2)', [hash, person.id]);
		try {
			const me = await get('/api/me', token);
			if (Number(me.body.me?.id) !== Number(person.id) || me.body.me.admin !== false)
				throw Error('Sesión con identidad o privilegios distintos');
			const actual = await get('/api/agents', token);
			const expected = (
				await db.query(
					`select a.id from agents a where a.deleted_at is null and
				(a.person_id=$1 or exists(select 1 from agent_shares s where s.agent_id=a.id and s.person_id=$1)) order by a.id`,
					[person.id],
				)
			).rows.map((r) => Number(r.id));
			if (
				actual.status !== 200 ||
				JSON.stringify(actual.body.agents.map((a) => Number(a.id)).sort((a, b) => a - b)) !== JSON.stringify(expected)
			)
				throw Error('Visibilidad incorrecta');
			peopleVisibilityChecked++;
		} finally {
			await db.query('delete from sessions where token_hash=$1', [hash]);
		}
	}
	const root = await fetch('http://127.0.0.1:8787/');
	if (!root.ok || !(await root.text()).includes('<html')) throw Error('Web no disponible');
	console.log(
		JSON.stringify({
			ok: true,
			people: people.length,
			agents: agents.length,
			activeAgents: agents.filter((a) => !a.deleted_at).length,
			retired16Preserved: true,
			separateAngelAndAngelk: true,
			fieldsDecrypted,
			peopleVisibilityChecked,
			syntheticSessionsRemoved: true,
			realBrowserLoginTested: false,
			inferenceRequests: 0,
			cronPausedDuringAcceptance: true,
			whatsapp404: true,
			web200: true,
		}),
	);
} finally {
	key.fill(0);
	await db.end();
}
