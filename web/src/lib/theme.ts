// Nova uses the same key, explicit light/dark modes and OS fallback on first load.
import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark';
const KEY = 'cuby-theme';
const EVENT = 'cuby-theme-change';

function apply(mode: ThemeMode) {
	document.documentElement.classList.toggle('dark', mode === 'dark');
	document.documentElement.dataset.theme = mode;
}

export function setTheme(mode: ThemeMode) {
	try {
		localStorage.setItem(KEY, mode);
	} catch {
		/* The in-memory preference still works. */
	}
	apply(mode);
	window.dispatchEvent(new Event(EVENT));
}

function subscribe(changed: () => void) {
	const storage = (event: StorageEvent) => {
		if (event.key !== KEY && event.key !== null) return;
		const mode = event.newValue;
		apply(
			mode === 'light' || mode === 'dark'
				? mode
				: matchMedia('(prefers-color-scheme: dark)').matches
					? 'dark'
					: 'light',
		);
		changed();
	};
	window.addEventListener(EVENT, changed);
	window.addEventListener('storage', storage);
	return () => {
		window.removeEventListener(EVENT, changed);
		window.removeEventListener('storage', storage);
	};
}

export function useTheme() {
	const mode = useSyncExternalStore(subscribe, () =>
		document.documentElement.dataset.theme === 'dark' ? ('dark' as const) : ('light' as const),
	);
	return { mode, set: setTheme, toggle: () => setTheme(mode === 'dark' ? 'light' : 'dark') };
}
