// Agents' database: Postgres (AGENTS_DATABASE_URL). The app's tables live in schema public; DBOS
// keeps its workflows, queues and schedules in schema dbos of the same database (see dbos.ts).
// People and sessions follow ~/dev/sonos: a name is the only login, admins type a shared PIN.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

export const DATA_DIR = process.env.AGENTS_DATA ?? 'data';
export const DATABASE_URL = process.env.AGENTS_DATABASE_URL ?? 'postgres://agents:agents@localhost:5432/agents';

// What the API hands the web stays as in the POC: ids, counts and money as numbers, times as
// unix ms. Only this pool parses like that; DBOS keeps pg's defaults on its own connections.
const INT8 = 20,
	NUMERIC = 1700,
	TIMESTAMP = 1114,
	TIMESTAMPTZ = 1184;
// "2026-10-26 19:25:32.12+00" -> ISO, which every engine parses.
const iso = (v: string) => v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
const parsers: Record<number, (v: string) => unknown> = {
	[INT8]: Number,
	[NUMERIC]: Number,
	[TIMESTAMP]: (v) => Date.parse(iso(v) + 'Z'),
	[TIMESTAMPTZ]: (v) => Date.parse(iso(v)),
};

export const pool = new pg.Pool({
	connectionString: DATABASE_URL,
	max: 10,
	types: {
		getTypeParser: ((oid: number, format?: string) =>
			parsers[oid] ?? pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
	},
});

export type Exec = Pick<pg.PoolClient, 'query'>;

export async function rows<T = any>(sql: string, params: unknown[] = [], on: Exec = pool) {
	return (await on.query(sql, params)).rows as T[];
}

export async function row<T = any>(sql: string, params: unknown[] = [], on: Exec = pool) {
	return ((await on.query(sql, params)).rows[0] ?? null) as T | null;
}

export async function exec(sql: string, params: unknown[] = [], on: Exec = pool) {
	return (await on.query(sql, params)).rowCount ?? 0;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>) {
	const c = await pool.connect();
	try {
		await c.query('begin');
		const out = await fn(c);
		await c.query('commit');
		return out;
	} catch (err) {
		await c.query('rollback').catch(() => {});
		throw err;
	} finally {
		c.release();
	}
}

/** Tokens are stored as their sha256, never in the clear. */
export const hash = (token: string) => createHash('sha256').update(token).digest();

export const now = () => Date.now();

/** Applies server/migrations/NNN_*.sql in order, once each, under an advisory lock. */
export async function migrate(dir = join(import.meta.dir, '..', 'migrations')) {
	const files = readdirSync(dir)
		.filter((f) => /^\d+_.+\.sql$/.test(f))
		.sort();
	await tx(async (c) => {
		await c.query("select pg_advisory_xact_lock(hashtext('agents.migrate'))");
		await c.query(
			'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())',
		);
		const done = new Set(
			(await rows<{ version: string }>('select version from schema_migrations', [], c)).map((r) => r.version),
		);
		for (const f of files) {
			if (done.has(f)) continue;
			await c.query(readFileSync(join(dir, f), 'utf8'));
			await c.query('insert into schema_migrations (version) values ($1)', [f]);
			console.log(`migrated ${f}`);
		}
	});
}
