// The container monitor (Q2, Q3) and /metrics. Every few seconds: the live runs from Postgres, the
// sandboxes Docker has for this instance, what each one uses, and the host. Each person sees their
// own runs and queue places; an admin sees everyone's, the host, and the orphans (sandboxes no live
// run owns), which it can clean. The history and alerts live in Prometheus/Grafana, from /metrics.
import { rows } from './db';
import * as hub from './hub';
import { INSTANCE } from './tasks';
import { DockerSandbox } from './sandbox/docker';
import type { HostInfo, SandboxStats, SandboxProvider } from './sandbox/provider';
import type { Person } from './people';

const provider: SandboxProvider = new DockerSandbox();
const EVERY_MS = 5000;
const SANDBOX_BYTES = 1536 * 1024 * 1024; // what each run reserves (tasks.ts)

export type MonitorRow = {
	run_id: number; agent_id: number; agent: string; person_id: number; person: string; status: string; state: string;
	created_at: number; started_at: number | null; cost: number; tokens: number; priority: number;
	queue_position: number | null; person_queue_position: number | null;
	container: ({ id: string } & SandboxStats) | null;
};
export type Orphan = { id: string; name: string; run: string | null; state: string; created: number };
type Snapshot = { at: number; rows: MonitorRow[]; orphans: Orphan[]; host: HostInfo | null };

let snap: Snapshot = { at: 0, rows: [], orphans: [], host: null };
export const snapshot = () => snap;

async function collect() {
	const runs = await rows<Omit<MonitorRow, 'queue_position' | 'person_queue_position' | 'container'>>(
		`select r.id as run_id, r.agent_id, a.name as agent, r.person_id, p.name as person, r.status, r.state,
		        r.created_at, r.started_at, r.cost, r.tokens, r.priority
		 from runs r join agents a on a.id = r.agent_id join people p on p.id = r.person_id
		 where r.status in ('queued','starting','running','blocked') order by r.priority, r.created_at, r.id`
	);
	const containers = await provider.list(`agents.instance=${INSTANCE}`);
	const live = new Set(runs.map((r) => String(r.run_id)));
	const byRun = new Map(containers.filter((c) => c.labels['agents.run']).map((c) => [c.labels['agents.run'], c]));
	const orphans = containers
		.filter((c) => !live.has(c.labels['agents.run'] ?? ''))
		.map((c) => ({ id: c.id, name: c.name, run: c.labels['agents.run'] ?? null, state: c.state, created: c.created }));
	const stats = await Promise.all(
		runs.map(async (r) => {
			const c = byRun.get(String(r.run_id));
			if (!c || c.state !== 'running') return null;
			const s = await provider.stats(c.id);
			return s && { id: c.id, ...s };
		})
	);
	// The queue in the order DBOS dequeues it: priority, then arrival.
	let global = 0;
	const perPerson = new Map<number, number>();
	const out: MonitorRow[] = runs.map((r, i) => {
		const queued = r.status === 'queued';
		const mine = queued ? (perPerson.get(r.person_id) ?? 0) + 1 : null;
		if (queued) perPerson.set(r.person_id, mine!);
		return { ...r, queue_position: queued ? ++global : null, person_queue_position: mine, container: stats[i] };
	});
	snap = { at: Date.now(), rows: out, orphans, host: await provider.host().catch(() => null) };
	hub.monitor((v) => view(v.person));
}

/** What a viewer may see: their own runs; an admin also everyone's, the host and the orphans. */
export function view(person: Person) {
	const s = snap;
	if (person.admin) {
		const fits = s.host ? Math.max(0, Math.floor(s.host.memoryAvailable / SANDBOX_BYTES)) : null;
		return { t: 'monitor', at: s.at, rows: s.rows, orphans: s.orphans, host: s.host && { ...s.host, fits } };
	}
	return { t: 'monitor', at: s.at, rows: s.rows.filter((r) => r.person_id === person.id), orphans: [], host: null };
}

let running = false;
export function startMonitor() {
	setInterval(() => {
		if (running) return;
		running = true;
		collect()
			.catch((err) => console.error('monitor:', (err as Error).message))
			.finally(() => (running = false));
	}, EVERY_MS);
}

/** Admin: removes the sandboxes no live run owns (checked again right now). */
export async function cleanOrphans() {
	const live = new Set(
		(await rows<{ id: number }>("select id from runs where status in ('queued','starting','running','blocked')")).map((r) => String(r.id))
	);
	let n = 0;
	for (const c of await provider.list(`agents.instance=${INSTANCE}`)) {
		if (live.has(c.labels['agents.run'] ?? '')) continue;
		await provider.destroy(c.id);
		n++;
	}
	await collect();
	return n;
}

// ---------- /metrics (Prometheus text format) ----------

const esc = (v: unknown) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
const labels = (l: Record<string, unknown>) => `{${Object.entries({ instance_name: INSTANCE, ...l }).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`;

export async function metricsText() {
	const s = snap;
	const lines: string[] = [];
	const metric = (name: string, type: string, help: string, samples: [Record<string, unknown>, number][]) => {
		lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
		for (const [l, v] of samples) lines.push(`${name}${labels(l)} ${Number.isFinite(v) ? v : 0}`);
	};
	const statuses = ['queued', 'starting', 'running', 'blocked'];
	metric('agents_runs_live', 'gauge', 'Live runs by status.', statuses.map((st) => [{ status: st }, s.rows.filter((r) => r.status === st).length]));
	const queue = new Map<number, { person: string; n: number }>();
	for (const r of s.rows) if (r.status === 'queued') queue.set(r.person_id, { person: r.person, n: (queue.get(r.person_id)?.n ?? 0) + 1 });
	metric('agents_queue_length', 'gauge', 'Runs waiting in the queue, per person.', [...queue].map(([id, q]) => [{ person_id: id, person: q.person }, q.n]));
	const withC = s.rows.filter((r) => r.container);
	const who = (r: MonitorRow) => ({ run: r.run_id, agent: r.agent, person: r.person });
	metric('agents_sandbox_cpu_percent', 'gauge', 'CPU a sandbox uses (100 = one core).', withC.map((r) => [who(r), r.container!.cpuPercent]));
	metric('agents_sandbox_memory_bytes', 'gauge', 'Memory a sandbox uses.', withC.map((r) => [who(r), r.container!.memoryBytes]));
	metric('agents_orphan_sandboxes', 'gauge', 'Sandboxes no live run owns.', [[{}, s.orphans.length]]);
	if (s.host) {
		metric('agents_host_memory_available_bytes', 'gauge', 'Host memory available.', [[{}, s.host.memoryAvailable]]);
		metric('agents_host_memory_total_bytes', 'gauge', 'Host memory in total.', [[{}, s.host.memoryTotal]]);
		metric('agents_host_cpus', 'gauge', 'Host CPUs.', [[{}, s.host.cpus]]);
		metric('agents_host_load1', 'gauge', 'Host load, 1 minute.', [[{}, s.host.load1]]);
	}
	const cost = await rows<{ person_id: number; person: string; cost: number }>(
		'select p.id as person_id, p.name as person, coalesce(sum(r.cost), 0) as cost from people p left join runs r on r.person_id = p.id group by p.id'
	);
	metric('agents_cost_usd_total', 'counter', 'What runs have cost, per person (US$).', cost.map((c) => [{ person_id: c.person_id, person: c.person }, c.cost]));
	const ended = await rows<{ status: string; n: number }>('select status, count(*) as n from runs group by status');
	metric('agents_runs_total', 'counter', 'Runs ever, by current status.', ended.map((e) => [{ status: e.status }, e.n]));
	const start = await rows<{ secs: number | null }>(
		"select avg(extract(epoch from started_at - created_at))::float as secs from runs where started_at > now() - interval '1 hour'"
	);
	metric('agents_run_start_seconds_avg', 'gauge', 'Average wait from launch to sandbox start, last hour.', [[{}, start[0]?.secs ?? 0]]);
	metric('agents_stream_bytes_total', 'counter', 'Bytes of browser images sent to viewers.', [[{ kind: 'thumb' }, hub.sent.thumb], [{ kind: 'frame' }, hub.sent.frame]]);
	metric('agents_monitor_age_seconds', 'gauge', 'Seconds since the monitor last collected.', [[{}, s.at ? (Date.now() - s.at) / 1000 : -1]]);
	return lines.join('\n') + '\n';
}
