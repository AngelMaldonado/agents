// App publicada sobre una tercera copia: sin red, socket Docker ni tareas/cron activos.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
const require = createRequire('/app/server/package.json');
const { Pool } = require('pg');
export function envValue(text, key) {
	const lines = text.split('\n').filter((line) => line.startsWith(key + '='));
	if (lines.length !== 1) throw new Error('Falta variable o está duplicada');
	let value = lines[0].slice(key.length + 1).trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		value = value.slice(1, -1);
	if (!value || /[\r\n\0]/.test(value)) throw new Error('Variable inválida');
	return value;
}
if (process.env.AGENTS_BOOT_PROBE === 'server') {
	const text = fs.readFileSync('/run/production.env', 'utf8');
	for (const key of ['AGENTS_MASTER_KEY', 'AGENTS_ADMIN_PIN', 'AGENTS_PROXY_KEY'])
		process.env[key] = envValue(text, key);
	const db = new Pool({ host: '/socket', user: 'agents', database: 'agents_migration_recovery' });
	if (
		Number(
			(
				await db.query(
					"select count(*) as n from dbos.workflow_status where status not in ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')",
				)
			).rows[0].n,
		) ||
		Number(
			(await db.query("select count(*) as n from runs where status in ('queued','starting','running','blocked')"))
				.rows[0].n,
		) ||
		Number((await db.query('select count(*) as n from messages where routed_at is null')).rows[0].n) ||
		Number((await db.query("select count(*) as n from webhook_deliveries where status='pending'")).rows[0].n)
	)
		throw new Error('No se arranca con negocio pendiente');
	await db.query("update dbos.workflow_schedules set status='PAUSED'");
	await db.end();
	process.chdir('/app/server');
	const { default: application } = await import('/app/server/src/index.ts');
	Bun.serve(application);
}
if (process.env.AGENTS_BOOT_PROBE === 'verify') {
	const db = new Pool({ host: '/socket', user: 'agents', database: 'agents_migration_recovery' });
	try {
		const get = async (url, cookie) => {
			const r = await fetch('http://127.0.0.1:8787' + url, {
				headers: cookie ? { cookie: 'agents_session=' + cookie } : {},
			});
			return { status: r.status, data: await r.json() };
		};
		const health = await get('/healthz');
		if (
			!health.data.ready ||
			health.data.version !== '0.0.1-beta' ||
			health.data.sha !== 'f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3'
		)
			throw new Error('Release diferente');
		if ((await get('/api/agents')).status !== 401 || (await get('/api/admin/whatsapp')).status !== 404)
			throw new Error('Guardas HTTP diferentes');
		let peopleChecked = 0;
		for (const person of (await db.query('select id from people order by id')).rows) {
			const token = randomBytes(32).toString('base64url');
			const hash = createHash('sha256').update(token).digest();
			await db.query('insert into sessions(token_hash,person_id) values($1,$2)', [hash, person.id]);
			try {
				const me = await get('/api/me', token);
				if (Number(me.data.me?.id) !== Number(person.id) || me.data.me.admin !== false)
					throw new Error('Identidad incorrecta');
				const actual = await get('/api/agents', token);
				const expected = (
					await db.query(
						`select a.id from agents a where a.deleted_at is null and
					(a.person_id=$1 or exists(select 1 from agent_shares s where s.agent_id=a.id and s.person_id=$1)) order by a.id`,
						[person.id],
					)
				).rows.map((r) => Number(r.id));
				const ids = actual.data.agents.map((a) => Number(a.id)).sort((a, b) => a - b);
				if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error('Visibilidad diferente');
				peopleChecked++;
			} finally {
				await db.query('delete from sessions where token_hash=$1', [hash]);
			}
		}
		if (Number((await db.query("select count(*) as n from dbos.workflow_schedules where status<>'PAUSED'")).rows[0].n))
			throw new Error('Cron no pausado');
		if ((await db.query("select 1 from people where key='test'")).rowCount) throw new Error('Test no excluido');
		const root = await fetch('http://127.0.0.1:8787/');
		if (!root.ok || !(await root.text()).includes('<html')) throw new Error('Web no disponible');
		console.log(
			JSON.stringify({
				ok: true,
				health: health.data,
				peopleVisibilityChecked: peopleChecked,
				syntheticSessionsOnly: true,
				realBrowserLoginTested: false,
				cronPausedOnlyInRecoveryCopy: true,
				modelCalls: 0,
				network: 'none',
				dockerSocketMounted: false,
				whatsapp404: true,
				web200: true,
			}),
		);
	} finally {
		await db.end();
	}
}
if (process.env.AGENTS_BOOT_PROBE === 'custody') {
	const runtime = JSON.parse(fs.readFileSync(0, 'utf8'));
	const env = Object.fromEntries(
		runtime.map((v) => {
			const i = v.indexOf('=');
			return [v.slice(0, i), v.slice(i + 1)];
		}),
	);
	const text = fs.readFileSync('/run/production.env', 'utf8');
	const matches = {};
	for (const key of ['AGENTS_MASTER_KEY', 'AGENTS_ADMIN_PIN', 'AGENTS_PROXY_KEY']) {
		matches[key] = envValue(text, key) === env[key];
		if (!matches[key]) throw new Error('Archivo no coincide con configuración efectiva');
	}
	console.log(
		JSON.stringify({ runtimeMatchesPrivateFile: matches, activeKeyRotated: false, offHostEscrowVerified: false }),
	);
}
