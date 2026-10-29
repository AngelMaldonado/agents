// The live feed: one WebSocket per browser tab. The server sends by topic: task updates and ~1 fps
// thumbnails for the gallery always; an agent's full stream and events only while its view is open
// (watch); the monitor only while its page is open. After a reconnect the subscriptions are sent
// again and views refetch what they missed (useConnected).
// Frames (thumbnails or full) are kept per agent, the newest only.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Task, TaskEvent } from './api';

export type Frame = { taskId: number; jpeg: string; meta: { url?: string; deviceWidth?: number; deviceHeight?: number } | null; at: number };

type Listener = () => void;
const frames = new Map<number, Frame>(); // agent id -> frame
const frameSubs = new Map<number, Set<Listener>>();
const taskSubs = new Set<(t: Task) => void>();
const eventSubs = new Set<(taskId: number, e: TaskEvent) => void>();
let connected = false;
const connSubs = new Set<Listener>();

function setConnected(v: boolean) {
	connected = v;
	connSubs.forEach((l) => l());
}

const watching = new Map<number, number>(); // agent id -> how many views watch it
const monitorSubs = new Set<(m: any) => void>();

function tell(msg: object) {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Takeover: one mouse or keyboard event for the agent's Chrome (the server drops it unless you have control). */
export function sendInput(agentId: number, e: object) {
	tell({ t: 'input', agentId, e });
}

let ws: WebSocket | null = null;
export function connect() {
	if (ws) return;
	const open = () => {
		ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
		ws.onopen = () => {
			for (const agentId of watching.keys()) tell({ t: 'watch', agentId });
			if (monitorSubs.size) tell({ t: 'monitor', on: true });
			setConnected(true);
		};
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			if (m.t === 'frame' || m.t === 'thumb') {
				frames.set(m.agentId, { taskId: m.taskId, jpeg: m.jpeg, meta: m.meta, at: Date.now() });
				frameSubs.get(m.agentId)?.forEach((l) => l());
			} else if (m.t === 'task') {
				taskSubs.forEach((l) => l(m.task));
			} else if (m.t === 'event') {
				eventSubs.forEach((l) => l(m.taskId, m.event));
			} else if (m.t === 'monitor') {
				monitorSubs.forEach((l) => l(m));
			}
		};
		ws.onclose = () => {
			setConnected(false);
			ws = null;
			setTimeout(open, 1500);
		};
	};
	open();
}

/** While mounted, the agent's full stream and events come to this tab. */
export function useWatch(agentId: number, enabled = true) {
	useEffect(() => {
		if (!enabled) return;
		const n = (watching.get(agentId) ?? 0) + 1;
		watching.set(agentId, n);
		if (n === 1) tell({ t: 'watch', agentId });
		return () => {
			const left = (watching.get(agentId) ?? 1) - 1;
			if (left > 0) return void watching.set(agentId, left);
			watching.delete(agentId);
			tell({ t: 'unwatch', agentId });
		};
	}, [agentId, enabled]);
}

/** While mounted, the monitor's snapshots (every few seconds) go to `fn`. */
export function useMonitorFeed(fn: (m: any) => void) {
	useEffect(() => {
		monitorSubs.add(fn);
		if (monitorSubs.size === 1) tell({ t: 'monitor', on: true });
		return () => {
			monitorSubs.delete(fn);
			if (!monitorSubs.size) tell({ t: 'monitor', on: false });
		};
	}, [fn]);
}

export function useFrame(agentId: number) {
	return useSyncExternalStore(
		(l) => {
			if (!frameSubs.has(agentId)) frameSubs.set(agentId, new Set());
			frameSubs.get(agentId)!.add(l);
			return () => frameSubs.get(agentId)!.delete(l);
		},
		() => frames.get(agentId)
	);
}

export function useConnected() {
	return useSyncExternalStore(
		(l) => {
			connSubs.add(l);
			return () => connSubs.delete(l);
		},
		() => connected
	);
}

export function onTask(fn: (t: Task) => void) {
	taskSubs.add(fn);
	return () => {
		taskSubs.delete(fn);
	};
}

export function onEvent(fn: (taskId: number, e: TaskEvent) => void) {
	eventSubs.add(fn);
	return () => {
		eventSubs.delete(fn);
	};
}

/** Re-renders once a second, for "hace 12s" labels and elapsed time. */
export function useTick(ms = 1000) {
	const [, set] = useState(0);
	useEffect(() => {
		const id = setInterval(() => set((n) => n + 1), ms);
		return () => clearInterval(id);
	}, [ms]);
}
