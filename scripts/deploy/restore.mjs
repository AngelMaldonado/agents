// Offline rehearsal ONLY. No server, DBOS worker, Docker socket or network is started here.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export function parseMasterKey(text) {
	const lines = text.split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?AGENTS_MASTER_KEY\s*=/.test(line));
	if (lines.length !== 1) throw new Error('Llave ausente o ambigua');
	let value = lines[0].slice(lines[0].indexOf('=') + 1).trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		value = value.slice(1, -1);
	const key = Buffer.from(value, 'base64');
	if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Llave inválida');
	return key;
}

export function decrypt(value, key) {
	const [version, iv, tag, body, extra] = value.split('.');
	if (version !== 'v1' || !iv || !tag || body === undefined || extra !== undefined) throw new Error('Formato inválido');
	const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
	cipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]);
}

export function encrypt(value, key) {
	const iv = randomBytes(12),
		cipher = createCipheriv('aes-256-gcm', key, iv);
	const body = Buffer.concat([cipher.update(value), cipher.final()]);
	return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(
		'.',
	);
}

const sealedTables = [
	['provider_keys', ['person_id', 'provider'], ['key_enc']],
	['proxy_accounts', ['person_id'], ['key_enc']],
	['agent_webhooks', ['agent_id'], ['in_secret_enc', 'out_secret_enc']],
	['credentials', ['id'], ['username_enc', 'password_enc', 'totp_enc']],
	['agent_secrets', ['agent_id', 'name'], ['value_enc']],
];

// Orden canónico compartido con Python: vincula el probe al manifiesto exacto, no sólo al ID.
const canonical = (value) =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === 'object'
			? Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, canonical(value[key])]),
				)
			: value;
export const inputHash = (value) =>
	createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');

export function imageRevisionPlan(agents, { decision, probes, imageId }) {
	const sandbox =
		'registry.cubytest.space/cuby/agents-sandbox@sha256:04771072a9d1064e52c034b1f59a1db7c46f695c760568cc9af76d20d5bebd40';
	if (
		decision?.id !== 'angel-beta-existing-images-2026-10-31' ||
		decision.release !== '0.0.1-beta' ||
		decision.releaseSha !== 'f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3' ||
		decision.sandboxImage !== sandbox ||
		decision.scope !== 'active-non-test-agents' ||
		decision.authorizedBy !== 'Angel (operador)' ||
		decision.execution !== 'rehearsal-only' ||
		decision.cutoverAuthorized !== false ||
		!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')
	)
		throw new Error('Transición de imagen no autorizada para este ensayo');
	if (!Array.isArray(probes) || new Set(probes.map((p) => p.agent)).size !== probes.length)
		throw new Error('Probes ausentes o ambiguos');
	return agents
		.filter((a) => a.deleted_at === null)
		.map((a) => {
			const probe = probes.find((p) => p.agent === Number(a.id));
			if (
				Number(a.person_id) === 1 ||
				!Number.isSafeInteger(a.config_revision) ||
				a.config_revision < 1 ||
				a.config_revision >= 2147483647 ||
				probe?.ok !== true ||
				probe.image !== sandbox ||
				probe.imageId !== imageId ||
				probe.inputSha256 !== inputHash(a.harness)
			)
				throw new Error('Agente sin probe satisfactorio de la misma imagen y manifiesto');
			return {
				agent: Number(a.id),
				fromRevision: a.config_revision,
				toRevision: a.config_revision + 1,
				fromImage: a.harness_image,
				image: imageId,
				imageRef: sandbox,
			};
		});
}

export function checkSourceSnapshot(agent, snapshot) {
	if (!snapshot) throw new Error('Revisión histórica ausente; no se inventa');
	if (['name', 'role', 'model', 'harness'].some((key) => inputHash(snapshot[key]) !== inputHash(agent[key])))
		throw new Error('Definición histórica divergente fuera de la transición autorizada');
	// La autorización cambia la imagen efectiva, NO repara ni reescribe el snapshot previo.
	return snapshot.image === agent.harness_image
		? null
		: {
				agent: Number(agent.id),
				revision: agent.config_revision,
				historicalImage: snapshot.image,
				effectiveSourceImage: agent.harness_image,
			};
}

let phase = 'connect';
async function rehearsal() {
	const { Client } = createRequire('/app/server/package.json')('pg');
	const client = (database, readOnly = false) =>
		new Client({
			host: '/socket',
			user: 'agents',
			database,
			options: `-c statement_timeout=10000 -c lock_timeout=2000${readOnly ? ' -c default_transaction_read_only=on' : ''}`,
		});
	const db = client('agents_migration_rehearsal'),
		existing = client('agents_migration_existing', true);
	try {
		await db.connect();
		await existing.connect();
		for (const [c, expected] of [
			[db, 'agents_migration_rehearsal'],
			[existing, 'agents_migration_existing'],
		]) {
			const r = (await c.query('select current_database() as db, inet_server_addr() as addr')).rows[0];
			if (r.db !== expected || r.addr !== null) throw new Error('No es el socket de ensayo');
		}
		phase = 'load-keys';
		const sourceKey = parseMasterKey(readFileSync('/backup/development.env', 'utf8'));
		const destinationKey = parseMasterKey(readFileSync('/backup/production.env', 'utf8'));
		const scalar = async (sql, params = [], c = db) => Number((await c.query(sql, params)).rows[0].n);
		const test = (await db.query("select id from people where key='test'")).rows;
		if (test.length !== 1 || Number(test[0].id) !== 1) throw new Error('Test inesperado');
		const ids = (await db.query('select id from agents where person_id=1 order by id')).rows.map((r) => Number(r.id));
		if (JSON.stringify(ids) !== '[1,2,3,4,5,6,7,8,9]') throw new Error('Cambió alcance de Test');
		const fingerprint = async () => {
			const rows = (await db.query('select to_jsonb(a) as a from agents a where person_id<>1 order by id')).rows;
			return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
		};
		const before = await fingerprint();
		const counts = async () => ({
			people: await scalar("select count(*) as n from people where key<>'test'"),
			agents: await scalar('select count(*) as n from agents where person_id<>1'),
			activeAgents: await scalar('select count(*) as n from agents where person_id<>1 and deleted_at is null'),
			runs: await scalar('select count(*) as n from runs where agent_id not between 1 and 9'),
			conversations: await scalar('select count(*) as n from conversations where agent_id not between 1 and 9'),
		});
		const expected = await counts();
		// Don't destroy real users' drafts or credentials through cross-owner dependencies.
		if (
			await scalar(
				`select count(*) as n from agent_designs where person_id<>1 and
			(agent_id=any($1::bigint[]) or applied_agent_id=any($1::bigint[]) or init_run_id in
			(select id from runs where agent_id=any($1::bigint[])))`,
				[ids],
			)
		)
			throw new Error('Referencia cruzada');
		if (
			await scalar(`select count(*) as n from credential_grants g join credentials c on c.id=g.credential_id
			join agents a on a.id=g.agent_id where c.person_id=1 and a.person_id<>1`)
		)
			throw new Error('Credencial cruzada');
		// Production is not silently replaced/merged if it has accumulated application data.
		for (const table of ['agents', 'agent_designs', 'provider_keys', 'proxy_accounts', 'credentials', 'agent_secrets'])
			if (await scalar(`select count(*) as n from ${table}`, [], existing)) throw new Error('Producción no vacía');
		// JSON timestamp strings retain microseconds; JS Date would truncate them.
		const people = (await existing.query('select to_jsonb(p) as data from people p order by id')).rows.map(
			(r) => r.data,
		);
		if (people.length !== 1 || people[0].key !== 'angelk') throw new Error('Cuenta de producción cambió');
		const encColumns = (
			await db.query(`select table_name||'.'||column_name as column from information_schema.columns
			where table_schema='public' and right(column_name,4)='_enc' order by 1`)
		).rows.map((r) => r.column);
		const known = sealedTables.flatMap(([table, , fields]) => fields.map((field) => `${table}.${field}`)).sort();
		if (JSON.stringify(encColumns) !== JSON.stringify(known)) throw new Error('Cifrado desconocido');
		phase = 'exclude-test';
		await db.query('BEGIN');
		await db.query('delete from agent_designs where person_id=1');
		await db.query('delete from agent_revisions where agent_id=any($1::bigint[])', [ids]);
		await db.query('delete from people where id=1');
		if ((await fingerprint()) !== before) throw new Error('Cambió definición de agentes reales');
		const after = await counts();
		if (JSON.stringify(after) !== JSON.stringify(expected)) throw new Error('Pérdida de datos reales');
		phase = 're-encrypt';
		let checked = 0,
			rekeyed = 0;
		for (const [table, keys, fields] of sealedTables) {
			for (const row of (await db.query(`select ${[...keys, ...fields].join(',')} from ${table}`)).rows) {
				for (const field of fields) {
					if (row[field] === null) continue;
					const plain = decrypt(row[field], sourceKey);
					checked++;
					const sealed = encrypt(plain, destinationKey);
					if (!decrypt(sealed, destinationKey).equals(plain)) throw new Error('Recifrado inválido');
					await db.query(
						`update ${table} set ${field}=$1 where ${keys.map((k, i) => `${k}=$${i + 2}`).join(' and ')}`,
						[sealed, ...keys.map((k) => row[k])],
					);
					plain.fill(0);
					rekeyed++;
				}
			}
		}
		// Preserve the existing production identity separately, never equate person IDs across databases.
		phase = 'preserve-production-identity';
		const identityMap = [];
		for (const p of people) {
			const id = (
				await db.query(
					`insert into people(name,key,avatar_seed,run_quota,created_at)
				values($1,$2,$3,$4,$5) returning id`,
					[p.name, p.key, p.avatar_seed, p.run_quota, p.created_at],
				)
			).rows[0].id;
			for (const table of ['sessions', 'invites']) {
				for (const { data: row } of (
					await existing.query(`select to_jsonb(x) as data from ${table} x where person_id=$1`, [p.id])
				).rows) {
					row.person_id = id;
					const columns = Object.keys(row);
					const allowed =
						table === 'sessions'
							? ['token_hash', 'person_id', 'admin_until', 'created_at', 'last_seen_at']
							: ['code_hash', 'person_id', 'created_at', 'expires_at', 'used_at'];
					if (columns.some((c) => !allowed.includes(c))) throw new Error('Cambió esquema de acceso');
					await db.query(
						`insert into ${table}(${columns.join(',')}) values(${columns.map((_, i) => `$${i + 1}`).join(',')})`,
						columns.map((c) => row[c]),
					);
				}
			}
			identityMap.push({ fromProduction: Number(p.id), toRehearsal: Number(id) });
		}
		if (
			(await scalar("select count(*) as n from people where key='test'")) ||
			(await scalar('select count(*) as n from agents where id=any($1::bigint[])', [ids]))
		)
			throw new Error('Test sigue presente');
		phase = 'new-image-revisions';
		const context = JSON.parse(process.env.AGENTS_MIGRATION_TRANSITION ?? 'null');
		const agentRows = async () =>
			(await db.query('select to_jsonb(a) as data from agents a order by id')).rows.map((r) => r.data);
		const revisionRows = async () =>
			(await db.query('select to_jsonb(r) as data from agent_revisions r order by agent_id,revision')).rows.map(
				(r) => r.data,
			);
		const originals = await agentRows(),
			revisionsBefore = await revisionRows();
		phase = 'image-transition-probe-binding';
		const changes = imageRevisionPlan(originals, context);
		const historicalKeys = new Set(revisionsBefore.map((r) => `${r.agent_id}:${r.revision}`));
		const sourceImageDifferences = [];
		for (const change of changes) {
			const original = originals.find((a) => Number(a.id) === change.agent);
			const snapshot = revisionsBefore.find(
				(r) => Number(r.agent_id) === change.agent && r.revision === change.fromRevision,
			);
			phase = 'image-transition-source-snapshot';
			const difference = checkSourceSnapshot(original, snapshot);
			if (difference) sourceImageDifferences.push(difference);
			phase = 'image-transition-revision-conflict';
			if (revisionsBefore.some((r) => Number(r.agent_id) === change.agent && r.revision >= change.toRevision))
				throw new Error('Conflicto de revisión');
			phase = 'image-transition-update';
			const result = await db.query(
				'update agents set harness_image=$1, config_revision=$2 where id=$3 and config_revision=$4 and deleted_at is null',
				[change.image, change.toRevision, change.agent, change.fromRevision],
			);
			if (result.rowCount !== 1) throw new Error('Cambió revisión durante el ensayo');
			phase = 'image-transition-insert';
			await db.query(
				`insert into agent_revisions(agent_id,revision,name,role,model,harness,image)
				select id,config_revision,name,role,model,harness,harness_image from agents where id=$1`,
				[change.agent],
			);
		}
		const expectedAgents = originals.map((a) => {
			const change = changes.find((c) => c.agent === Number(a.id));
			return change ? { ...a, harness_image: change.image, config_revision: change.toRevision } : a;
		});
		phase = 'image-transition-invariants';
		const revisionsAfter = await revisionRows();
		if (
			inputHash(expectedAgents) !== inputHash(await agentRows()) ||
			inputHash(revisionsBefore) !==
				inputHash(revisionsAfter.filter((r) => historicalKeys.has(`${r.agent_id}:${r.revision}`))) ||
			revisionsAfter.length !== revisionsBefore.length + changes.length
		)
			throw new Error('Se alteraron definiciones o revisiones históricas');
		phase = 'dbos-exclusion';
		const { prepareDbos } = await import('data:text/javascript;base64,' + process.env.AGENTS_MIGRATION_DBOS_MODULE);
		const dbos = await prepareDbos(db);
		phase = 'production-state-mapping';
		const stateMapping = [];
		for (const agent of expectedAgents) {
			if (agent.state_ref !== `agents-dev-agent-${agent.id}`) throw new Error('Estado de origen desconocido');
			const destination = `agents-prod-beta1-agent-${agent.id}`;
			await db.query('update agents set state_ref=$1 where id=$2', [destination, agent.id]);
			stateMapping.push({ agent: Number(agent.id), source: agent.state_ref, destination });
		}
		phase = 'default-sandbox-and-sessions';
		const savedSettings = (await db.query("select value from settings where key='settings'")).rows[0]?.value ?? {};
		await db.query(
			`insert into settings(key,value) values('settings',$1)
			on conflict(key) do update set value=excluded.value`,
			[JSON.stringify({ ...savedSettings, sandboxImage: context.decision.sandboxImage })],
		);
		// Los hosts son distintos: no trasplantar cookies ni privilegios de admin de desarrollo.
		// Se conservan accesos de producción con su identidad remapeada; el resto usa invitación nueva.
		const productionIds = identityMap.map((p) => p.toRehearsal);
		const devSessionsExcluded = (
			await db.query('delete from sessions where person_id<>all($1::bigint[])', [productionIds])
		).rowCount;
		const devInvitesExcluded = (
			await db.query('delete from invites where person_id<>all($1::bigint[])', [productionIds])
		).rowCount;
		phase = 'private-data-plan';
		const dataPaths = (await db.query('select path from files order by path')).rows.map((r) => r.path);
		const designFiles = (await db.query('select id,messages from agent_designs')).rows.flatMap((d) =>
			d.messages.flatMap((m) => (m.attachments ?? []).map((a) => `designs/${d.id}/${a.id}`)),
		);
		const runIds = (await db.query('select id from runs order by id')).rows.map((r) => Number(r.id));
		writeFileSync(
			'/plan/data-plan.json',
			JSON.stringify({ dataPaths: [...new Set([...dataPaths, ...designFiles])], runIds }),
			{ mode: 0o600 },
		);
		phase = 'final-history-conservation';
		if (inputHash(await counts()) !== inputHash({ ...expected, people: expected.people + identityMap.length }))
			throw new Error('Cambió historia real');
		await db.query('COMMIT');
		sourceKey.fill(0);
		destinationKey.fill(0);
		return {
			ok: true,
			preserved: expected,
			totalPeopleIncludingExistingProduction: await scalar('select count(*) as n from people'),
			removedTestAgents: ids.length,
			secretsDecrypted: checked,
			secretsReencrypted: rekeyed,
			existingProductionIdentityMap: identityMap,
			agentDefinitionsPreservedExceptAuthorizedImageRevision: true,
			dbos,
			stateMapping,
			sessions: {
				policy: 'production-preserved-development-reinvite',
				devSessionsExcluded,
				devInvitesExcluded,
				productionSessionsPreserved: true,
				developmentAdminPrivilegesTransferred: false,
			},
			defaultSandboxUpdatedInCopy: true,
			imageTransition: {
				decision: context.decision.id,
				authorizedBy: context.decision.authorizedBy,
				ownerApprovalsFabricated: false,
				sourceImageDifferences,
				changes,
				historicalRevisionsUnchanged: true,
				retiredAgentsUnchanged: true,
			},
			pendingBeforeCutover: [
				'new production logins by invitation and integration acceptance',
				'final runtime URL/proxy/network checks',
				'repeat signature/image availability checks at the authorized cutover',
				'coordinated final backup and approval',
			],
		};
	} finally {
		await db.end().catch(() => {});
		await existing.end().catch(() => {});
	}
}

if (process.env.AGENTS_MIGRATION_WORKER === 'true') {
	rehearsal()
		.then((report) => console.log(JSON.stringify(report)))
		.catch((error) => {
			console.log(
				JSON.stringify({
					ok: false,
					phase,
					error: 'Fallo aislado; se omiten datos privados y detalles SQL.',
					failureCode: /^(?:[0-9A-Z]{5}|EACCES|ENOENT|ENOSPC)$/.test(error.code ?? '') ? error.code : undefined,
				}),
			);
		});
}
