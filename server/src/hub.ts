// The browsers watching, by topic (Q12). Each viewer is in:
//   persona:<id>  (its person) and admin (with the PIN): task updates and ~1 fps thumbnails, the gallery
//   agente:<id>   while its agent's view is open: the full ~5 fps stream and the run's events
//   monitor       while the Monitor page is open: containers, queue and (admins) the host
// Frames are read-only: nothing a browser sends ever reaches a sandbox's browser.
import type { Person } from './people';

export type Viewer = { person: Person; send: (data: string) => void; watching: Set<number>; monitor: boolean };

const viewers = new Set<Viewer>();
const lastThumb = new Map<number, string>(); // agent id -> newest thumbnail message, for the gallery of late joiners
const lastFrame = new Map<number, string>(); // agent id -> newest full frame, for whoever opens the agent
const owners = new Map<number, number>(); // agent id -> owner, for the agents that have frames
export const sent = { thumb: 0, frame: 0 }; // bytes, for /metrics

let onWatchers: (agentId: number, watched: boolean) => void = () => {};
/** Tells the run's supervisor to stream its full frames only while someone watches. */
export const onWatchChange = (fn: typeof onWatchers) => void (onWatchers = fn);

export function join(person: Person, send: (data: string) => void) {
	const v: Viewer = { person, send, watching: new Set(), monitor: false };
	viewers.add(v);
	for (const [agentId, data] of lastThumb) if (canSee(v, owners.get(agentId)!)) send(data);
	return v;
}

export function leave(v: Viewer) {
	viewers.delete(v);
	for (const agentId of v.watching) if (!watchers(agentId)) onWatchers(agentId, false);
}

function canSee(v: Viewer, ownerId: number) {
	return v.person.admin || v.person.id === ownerId;
}

export const watchers = (agentId: number) => [...viewers].filter((v) => v.watching.has(agentId)).length;

/** The viewer opened an agent it may see (the caller checked): its stream and events start. */
export function watch(v: Viewer, agentId: number, ownerId: number) {
	if (!canSee(v, ownerId) || v.watching.has(agentId)) return;
	const first = !watchers(agentId);
	v.watching.add(agentId);
	const f = lastFrame.get(agentId);
	if (f) v.send(f);
	if (first) onWatchers(agentId, true);
}

export function unwatch(v: Viewer, agentId: number) {
	if (!v.watching.delete(agentId)) return;
	if (!watchers(agentId)) onWatchers(agentId, false);
}

export const setMonitor = (v: Viewer, on: boolean) => void (v.monitor = on);

/** persona + admin: what the gallery shows. */
export function publish(ownerId: number, msg: Record<string, unknown>) {
	const data = JSON.stringify(msg);
	for (const v of viewers) if (canSee(v, ownerId)) v.send(data);
}

/** agente: only those with the agent's view open. */
export function toWatchers(agentId: number, ownerId: number, msg: Record<string, unknown>) {
	const data = JSON.stringify(msg);
	for (const v of viewers) if (v.watching.has(agentId) && canSee(v, ownerId)) v.send(data);
}

export function thumb(ownerId: number, taskId: number, agentId: number, jpeg: string, meta: unknown) {
	const data = JSON.stringify({ t: 'thumb', taskId, agentId, jpeg, meta });
	lastThumb.set(agentId, data);
	owners.set(agentId, ownerId);
	for (const v of viewers) if (canSee(v, ownerId)) {
		v.send(data);
		sent.thumb += data.length;
	}
}

export function frame(ownerId: number, taskId: number, agentId: number, jpeg: string, meta: unknown) {
	const data = JSON.stringify({ t: 'frame', taskId, agentId, jpeg, meta });
	lastFrame.set(agentId, data);
	owners.set(agentId, ownerId);
	for (const v of viewers) if (v.watching.has(agentId) && canSee(v, ownerId)) {
		v.send(data);
		sent.frame += data.length;
	}
}

/** monitor: each viewer gets the view its role allows (built by the caller). */
export function monitor(view: (v: Viewer) => Record<string, unknown> | null) {
	for (const v of viewers) {
		if (!v.monitor) continue;
		const msg = view(v);
		if (msg) v.send(JSON.stringify(msg));
	}
}

export function forgetAgent(agentId: number) {
	lastThumb.delete(agentId);
	lastFrame.delete(agentId);
	owners.delete(agentId);
}
