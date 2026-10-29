import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, type Agent, type Person, type PublicSettings } from './api';
import { connect, onTask, useConnected } from './live';
import { Entry, Invite } from './Entry';
import { Gallery } from './Gallery';
import { Monitor } from './Monitor';
import { Settings } from './Settings';
import { Admin } from './Admin';
import { AppShell } from '@/components/app-shell';
import { Skeleton } from '@/components/ui/skeleton';

// Keep the markdown renderer and detailed agent controls out of the initial gallery bundle.
const AgentView = lazy(() => import('./AgentView').then((module) => ({ default: module.AgentView })));
const AgentDesigner = lazy(() => import('./AgentDesigner').then((module) => ({ default: module.AgentDesigner })));

function useHash() {
	const [hash, setHash] = useState(location.hash.slice(1) || '/');
	useEffect(() => {
		const on = () => setHash(location.hash.slice(1) || '/');
		addEventListener('hashchange', on);
		return () => removeEventListener('hashchange', on);
	}, []);
	return hash;
}
const go = (path: string) => (location.hash = path);

export function App() {
	const hash = useHash();
	const [me, setMe] = useState<Person | null | undefined>(undefined);
	const [pinIsSet, setPinIsSet] = useState(false);
	const [settings, setSettings] = useState<PublicSettings | null>(null);
	const [agents, setAgents] = useState<Agent[]>([]);
	const connected = useConnected();

	const loadMe = useCallback(async () => {
		const r = await api('/me');
		setMe(r.me);
		setPinIsSet(r.pinIsSet);
		setSettings(r.settings);
	}, []);
	const loadAgents = useCallback(() => api('/agents').then((r) => setAgents(r.agents)).catch(() => {}), []);

	useEffect(() => {
		void loadMe();
	}, []);
	useEffect(() => {
		if (!me) return;
		connect();
		void loadAgents();
		// Live task updates patch the gallery in place.
		return onTask((t) => setAgents((as) => as.map((a) => (a.id === t.agent_id && (!a.task || a.task.id <= t.id) ? { ...a, task: t } : a))));
	}, [me?.id, me?.admin]);
	// After a reconnect, refetch what may have changed meanwhile.
	useEffect(() => {
		if (connected && me) void loadAgents();
	}, [connected]);

	const invite = hash.match(/^\/invite\/(.+)$/);
	if (invite) return <Invite code={invite[1]} onIn={loadMe} />;
	if (me === undefined) return <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 px-6" role="status" aria-label="Cargando Agents"><Skeleton className="h-8 w-32" /><Skeleton className="h-4 w-full" /><Skeleton className="h-10 w-full" /></div>;
	if (!me) return <Entry onIn={loadMe} />;
	if (!settings) return null;

	const designerMatch = hash.match(/^\/new(?:\/([\da-f-]+))?$/i);
	const agentMatch = hash.match(/^\/agent\/(\d+)(?:\/(improve)(?:\/([\da-f-]+))?)?$/i);
	const artifactMatch = hash.match(/^\/agent\/(\d+)\/artifact\/(\d+)\/([^/]+)$/i);
	let artifact = null;
	if (artifactMatch) { try { artifact = { runId:Number(artifactMatch[2]), name:decodeURIComponent(artifactMatch[3]) }; } catch { /* Invalid URL stays an unavailable route. */ } }
	const agentId = Number(agentMatch?.[1] ?? artifactMatch?.[1]);
	const agent = agents.find(a => a.id === agentId);
	const changed = async () => {
		await loadMe();
		await loadAgents();
	};

	return (
		<AppShell me={me} connected={connected} hash={hash} agentName={agent?.name}>
				{designerMatch ? (
					<Suspense fallback={<div className="page" role="status">Cargando diseñador…</div>}><AgentDesigner settings={settings} designId={designerMatch[1]} onDraft={(id) => go(`/new/${id}`)} onApplied={async (id) => { await loadAgents(); go(`/agent/${id}`); }} onBack={() => { void loadAgents(); go('/'); }} /></Suspense>
				) : hash === '/monitor' ? (
					<Monitor key={String(me.admin)} me={me} />
				) : hash === '/settings' ? (
					<Settings me={me} agents={agents} />
				) : hash === '/admin' ? (
					<Admin me={me} pinIsSet={pinIsSet} onChanged={changed} />
				) : agent ? (
					<Suspense fallback={<div className="page" role="status">Cargando agente…</div>}><AgentView key={agent.id} agent={agent} me={me} settings={settings} improving={!!agentMatch?.[2]} designId={agentMatch?.[3]} artifact={artifact} onViewChange={(view, draft) => go(`/agent/${agent.id}${view === 'improve' ? `/improve${draft ? `/${draft}` : ''}` : ''}`)} onBack={() => go('/')} onChanged={changed} /></Suspense>
				) : agentMatch || artifactMatch ? (
					<div className="page"><p className="muted">Ese agente no existe o no es tuyo.</p></div>
				) : (
					<Gallery agents={agents} me={me} settings={settings} onOpen={(id) => go(`/agent/${id}`)} onChanged={loadAgents} />
				)}
		</AppShell>
	);
}
