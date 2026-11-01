import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, type Agent, type Person, type PublicSettings } from './api';
import { connect, onTask, useConnected } from './live';
import { Entry, Invite } from './Entry';
import { Gallery } from './Gallery';
import { AppShell } from '@/components/app-shell';
import { AppSettings, type SettingsTab } from '@/components/app-settings';
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
	const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
	// The old pages are sections of Configuración now: their links open it over the gallery.
	useEffect(() => {
		const tab = ({ '/settings': 'ai', '/monitor': 'monitor', '/admin': 'admin' } as const)[
			hash as '/settings' | '/monitor' | '/admin'
		];
		if (!tab) return;
		setSettingsTab(tab);
		history.replaceState(null, '', '#/');
		dispatchEvent(new HashChangeEvent('hashchange'));
	}, [hash]);

	const loadMe = useCallback(async () => {
		const r = await api('/me');
		setMe(r.me);
		setPinIsSet(r.pinIsSet);
		setSettings(r.settings);
	}, []);
	const loadAgents = useCallback(
		() =>
			api('/agents')
				.then((r) => setAgents(r.agents))
				.catch(() => {}),
		[],
	);

	useEffect(() => {
		void loadMe();
	}, []);
	useEffect(() => {
		if (!me) return;
		connect();
		void loadAgents();
		// Live task updates patch the gallery in place.
		return onTask((t) =>
			setAgents((as) => as.map((a) => (a.id === t.agent_id && (!a.task || a.task.id <= t.id) ? { ...a, task: t } : a))),
		);
	}, [me?.id, me?.admin]);
	// After a reconnect, refetch what may have changed meanwhile.
	useEffect(() => {
		if (connected && me) void loadAgents();
	}, [connected]);

	const invite = hash.match(/^\/invite\/(.+)$/);
	if (invite) return <Invite code={invite[1]} onIn={loadMe} />;
	if (me === undefined)
		return (
			<div
				className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 px-6"
				role="status"
				aria-label="Cargando Agents"
			>
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-10 w-full" />
			</div>
		);
	if (!me) return <Entry onIn={loadMe} />;
	if (!settings) return null;

	const designerMatch = hash.match(/^\/new(?:\/([\da-f-]+))?$/i);
	const agentMatch = hash.match(/^\/agent\/(\d+)(?:\/(improve)(?:\/([\da-f-]+))?|\/chat\/(\d+)|\/(browser))?$/i);
	const artifactMatch = hash.match(/^\/agent\/(\d+)\/artifact\/(\d+)\/([^/]+)$/i);
	let artifact = null;
	if (artifactMatch) {
		try {
			artifact = { runId: Number(artifactMatch[2]), name: decodeURIComponent(artifactMatch[3]) };
		} catch {
			/* Invalid URL stays an unavailable route. */
		}
	}
	const agentId = Number(agentMatch?.[1] ?? artifactMatch?.[1]);
	const agent = agents.find((a) => a.id === agentId);
	const changed = async () => {
		await loadMe();
		await loadAgents();
	};

	return (
		<AppShell
			me={me}
			agents={agents}
			connected={connected}
			hash={hash}
			agentName={agent?.name}
			onSettings={() => setSettingsTab('ai')}
			onLogout={async () => {
				await api('/logout', { method: 'POST' });
				setSettingsTab(null);
				setAgents([]);
				setMe(null);
				go('/');
			}}
		>
			<AppSettings
				tab={settingsTab}
				onTab={setSettingsTab}
				onClose={() => setSettingsTab(null)}
				me={me}
				agents={agents}
				pinIsSet={pinIsSet}
				onChanged={changed}
			/>
			{designerMatch ? (
				<Suspense
					fallback={
						<div className="page" role="status">
							Cargando diseñador…
						</div>
					}
				>
					<AgentDesigner
						settings={settings}
						designId={designerMatch[1]}
						onDraft={(id) => go(`/new/${id}`)}
						onApplied={async (id) => {
							await loadAgents();
							go(`/agent/${id}`);
						}}
						onBack={() => {
							void loadAgents();
							go('/');
						}}
					/>
				</Suspense>
			) : agent ? (
				<Suspense
					fallback={
						<div className="page" role="status">
							Cargando agente…
						</div>
					}
				>
					<AgentView
						key={agent.id}
						agent={agent}
						me={me}
						settings={settings}
						improving={!!agentMatch?.[2]}
						designId={agentMatch?.[3]}
						chatId={agentMatch?.[4] ? Number(agentMatch[4]) : undefined}
						browsing={!!agentMatch?.[5]}
						artifact={artifact}
						onRoute={(suffix) => go(`/agent/${agent.id}${suffix}`)}
						onBack={() => go('/')}
						onChanged={changed}
					/>
				</Suspense>
			) : agentMatch || artifactMatch ? (
				<div className="page">
					<p className="muted">Ese agente no existe o no es tuyo.</p>
				</div>
			) : (
				<Gallery
					agents={agents}
					me={me}
					settings={settings}
					onOpen={(id) => go(`/agent/${id}`)}
					onChanged={loadAgents}
				/>
			)}
		</AppShell>
	);
}
