// DBOS: durable workflows and queues, inside this process, in the app's own Postgres (schema
// dbos). The version is fixed, not DBOS's hash of the code: a deploy must resume the runs the
// previous process left mid-way, and dev's bun --watch must too.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { DATABASE_URL } from './db';

export async function startDbos() {
	DBOS.setConfig({
		name: 'agents',
		applicationVersion: process.env.AGENTS_APP_VERSION ?? 'v2',
		systemDatabaseUrl: DATABASE_URL,
		systemDatabaseSchemaName: 'dbos',
		logLevel: process.env.AGENTS_DBOS_LOG ?? 'warn',
	});
	await DBOS.launch();
	launched = true;
}
/** Whether this process runs DBOS (the server does; tests and scripts usually do not). */
export let launched = false;

export const stopDbos = () => DBOS.shutdown();
