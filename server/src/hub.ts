// The browsers watching: each one sees its person's tasks, an admin sees everyone's.
// Frames are read-only: nothing a browser sends ever reaches a sandbox's browser.
import type { Person } from './people';

export type Viewer = { person: Person; send: (data: string) => void };

const viewers = new Set<Viewer>();
const lastFrame = new Map<number, string>(); // task id -> the newest frame message, for late joiners

export function join(v: Viewer) {
	viewers.add(v);
	return () => viewers.delete(v);
}

function canSee(v: Viewer, ownerId: number) {
	return v.person.admin || v.person.id === ownerId;
}

export function publish(ownerId: number, msg: Record<string, unknown>) {
	const data = JSON.stringify(msg);
	for (const v of viewers) if (canSee(v, ownerId)) v.send(data);
}

export function frame(ownerId: number, taskId: number, agentId: number, jpeg: string, meta: unknown) {
	const data = JSON.stringify({ t: 'frame', taskId, agentId, jpeg, meta });
	lastFrame.set(taskId, data);
	for (const v of viewers) if (canSee(v, ownerId)) v.send(data);
}

export function replayFrames(v: Viewer, owners: Map<number, number>) {
	for (const [taskId, data] of lastFrame) {
		const owner = owners.get(taskId);
		if (owner !== undefined && canSee(v, owner)) v.send(data);
	}
}

export function forgetFrame(taskId: number) {
	lastFrame.delete(taskId);
}
