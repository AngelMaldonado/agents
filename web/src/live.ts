// The live feed: one WebSocket per browser tab. Frames are kept per agent (the newest only),
// task updates and events are fanned out to whoever listens.
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

let ws: WebSocket | null = null;
export function connect() {
	if (ws) return;
	const open = () => {
		ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
		ws.onopen = () => setConnected(true);
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			if (m.t === 'frame') {
				frames.set(m.agentId, { taskId: m.taskId, jpeg: m.jpeg, meta: m.meta, at: Date.now() });
				frameSubs.get(m.agentId)?.forEach((l) => l());
			} else if (m.t === 'task') {
				taskSubs.forEach((l) => l(m.task));
			} else if (m.t === 'event') {
				eventSubs.forEach((l) => l(m.taskId, m.event));
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
