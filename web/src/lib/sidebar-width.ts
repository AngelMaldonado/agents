// The sidebar's width, which the person drags (components/sidebar-resizer.tsx). Ported from Nova
// (services/spa/src/lib/stores/sidebar-width.svelte.ts): in rem, so a width keeps its proportion
// when --ui-scale changes; per browser in localStorage, every access guarded (a private window or
// blocked storage throws), so the worst case is the default.
import { useCallback, useState } from 'react';

const KEY = 'sidebar.width';
export const SIDEBAR_DEFAULT_REM = 18;
export const SIDEBAR_MIN_REM = 14;
export const SIDEBAR_MAX_REM = 32;

const clamp = (rem: number) => Math.round(Math.min(SIDEBAR_MAX_REM, Math.max(SIDEBAR_MIN_REM, rem)) * 4) / 4;

function load() {
	try {
		const v = Number(localStorage.getItem(KEY));
		return Number.isFinite(v) && v > 0 ? clamp(v) : SIDEBAR_DEFAULT_REM;
	} catch {
		return SIDEBAR_DEFAULT_REM;
	}
}

function save(rem: number) {
	try {
		if (rem === SIDEBAR_DEFAULT_REM) localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, String(rem));
	} catch {
		/* storage blocked: the width lasts as long as the page */
	}
}

export type SidebarWidth = {
	rem: number;
	/** Clamped to [min, max] and to a quarter rem; `persist` writes it down. */
	set: (rem: number, persist?: boolean) => void;
	save: () => void;
	reset: () => void;
};

export function useSidebarWidth(): SidebarWidth {
	const [rem, setRem] = useState(load);
	const set = useCallback((value: number, persist = true) => {
		const next = clamp(value);
		setRem(next);
		if (persist) save(next);
	}, []);
	return {
		rem,
		set,
		save: () => save(rem),
		reset: () => set(SIDEBAR_DEFAULT_REM),
	};
}
