// Development only (the dev bubble): states the trabajo cards play without touching data, to see their
// animations: working, being evaluated, learned something, its tasks filling up, and the whole cycle.
import { useSyncExternalStore } from 'react';
import type { Conversation } from '@/api';

export type CardPreview = {
	live: boolean;
	evaluating: boolean;
	learned: boolean;
	/** Tasks done of PREVIEW_TASKS while they fill up; null: its own. */
	step: number | null;
	done: boolean;
	scored: boolean;
	all: boolean;
	playing: boolean;
};
export const PREVIEW_TASKS = 6;
const OFF: CardPreview = {
	live: false,
	evaluating: false,
	learned: false,
	step: null,
	done: false,
	scored: false,
	all: false,
	playing: false,
};

let state = OFF;
const listeners = new Set<() => void>();
const timers: ReturnType<typeof setTimeout>[] = [];
const emit = () => listeners.forEach((l) => l());
export function setPreview(next: Partial<CardPreview>) {
	state = { ...state, ...next };
	emit();
}
export function resetPreview() {
	timers.splice(0).forEach(clearTimeout);
	state = { ...OFF, all: state.all };
	emit();
}
export const usePreview = () =>
	useSyncExternalStore(
		(l) => (listeners.add(l), () => void listeners.delete(l)),
		() => state,
	);
export const active = (p: CardPreview) => p.live || p.evaluating || p.learned || p.step !== null || p.done || p.scored;

/** Its tasks fill up one by one. */
export function fill(then?: () => void) {
	timers.splice(0).forEach(clearTimeout);
	setPreview({ step: 0 });
	for (let i = 1; i <= PREVIEW_TASKS; i++)
		timers.push(
			setTimeout(() => {
				setPreview({ step: i });
				if (i === PREVIEW_TASKS) then?.();
			}, i * 700),
		);
}

/** The whole cycle: open, working while its tasks fill, done, evaluated, scored and learned. */
export function playCycle() {
	resetPreview();
	setPreview({ playing: true, step: 0 });
	timers.push(
		setTimeout(() => {
			setPreview({ live: true });
			fill(() =>
				timers.push(
					setTimeout(() => {
						setPreview({ live: false, done: true, evaluating: true });
						timers.push(
							setTimeout(() => setPreview({ evaluating: false, scored: true, learned: true, playing: false }), 3000),
						);
					}, 800),
				),
			);
		}, 800),
	);
}

/** A card as the preview plays it. */
export function previewed(c: Conversation, p: CardPreview): Conversation {
	if (!active(p)) return c;
	return {
		...c,
		...(p.step !== null
			? { tasks: PREVIEW_TASKS, tasks_done: p.step, task_now: p.step < PREVIEW_TASKS ? 'Cotizar HEB' : null }
			: {}),
		// Working: an open trabajo, not evaluated yet.
		...(p.live ? { live: true, status: 'open' as const, score: null, evaluation: null } : { live: false }),
		...(p.done || p.evaluating || p.scored ? { status: 'done' as const } : {}),
		...(p.evaluating ? { evaluation: 'pending' as const, score: null } : {}),
		...(p.scored ? { evaluation: 'done' as const, score: 78 } : {}),
		...(p.learned ? { learned: (c.learned ?? 0) + 1 } : {}),
	};
}
