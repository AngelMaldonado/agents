import { useCallback, useEffect, useState } from 'react';
import { api, type Agent, type Person, type PublicSettings } from './api';
import { connect, onTask, useConnected } from './live';
import { Entry, Invite } from './Entry';
import { Gallery } from './Gallery';
import { AgentView } from './AgentView';
import { Settings } from './Settings';
import { Admin } from './Admin';

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
	if (me === undefined) return null;
	if (!me) return <Entry onIn={loadMe} />;
	if (!settings) return null;

	const agentMatch = hash.match(/^\/agent\/(\d+)$/);
	const agent = agentMatch ? agents.find((a) => a.id === Number(agentMatch[1])) : null;
	const changed = async () => {
		await loadMe();
		await loadAgents();
	};

	return (
		<div className="app">
			<header className="top">
				<a className="brand" href="#/">Agents</a>
				<nav>
					<a href="#/" className={hash === '/' ? 'on' : ''}>Galería</a>
					<a href="#/settings" className={hash === '/settings' ? 'on' : ''}>Ajustes</a>
					<a href="#/admin" className={hash === '/admin' ? 'on' : ''}>{me.admin ? 'Admin ●' : 'Admin'}</a>
				</nav>
				<span className="who">
					<span className={`dot ${connected ? 'on' : ''}`} title={connected ? 'En vivo' : 'Reconectando…'} />
					{me.name}
				</span>
			</header>
			<main>
				{hash === '/settings' ? (
					<Settings me={me} agents={agents} />
				) : hash === '/admin' ? (
					<Admin me={me} pinIsSet={pinIsSet} onChanged={changed} />
				) : agent ? (
					<AgentView key={agent.id} agent={agent} me={me} settings={settings} onBack={() => go('/')} onChanged={changed} />
				) : agentMatch ? (
					<div className="page"><p className="muted">Ese agente no existe o no es tuyo.</p></div>
				) : (
					<Gallery agents={agents} me={me} settings={settings} onOpen={(id) => go(`/agent/${id}`)} onChanged={loadAgents} />
				)}
			</main>
		</div>
	);
}
