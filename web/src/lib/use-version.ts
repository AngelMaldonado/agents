// The running release, from the server's /healthz (AGENTS_RELEASE_VERSION; «development» locally).
// Read once per page load and shared by every caller.
import { useEffect, useState } from 'react';

let pending: Promise<string | null> | null = null;
const load = () =>
	(pending ??= fetch('/healthz')
		.then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
		.then((r) => r?.version ?? null)
		.catch(() => null));

/** «v0.0.1-beta», «dev» when running locally, or null until known (or if it can't be read). */
export function useVersion() {
	const [version, setVersion] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void load().then((v) => live && setVersion(v === 'development' ? 'dev' : v ? `v${v.replace(/^v/, '')}` : null));
		return () => {
			live = false;
		};
	}, []);
	return version;
}
