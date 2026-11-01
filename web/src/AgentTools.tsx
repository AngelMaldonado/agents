// An agent's settings: its accesses (Accesos, owner only). Its command-line tools are listed in
// Avanzado → Harness.
// Accesses are the person's (#24): site logins, MCP servers and API Keys, each granted to the agent
// with a switch, or added from here and granted to this agent alone. The harness' own MCP servers
// are approved through Automejora; what the migration could not move (conflicts) is resolved here.
import { useEffect, useState } from 'react';
import { api, ago, type AccessView, type Agent } from './api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DeleteButton } from '@/components/actions';
import { KeysSection, McpSection, useAccess } from './Access';
import { Vault } from './Settings';

type Secret = { name: string; updated_at: number };
type AgentAccess = AccessView & { conflicts: Secret[] };

/** Accesos: what the agent may log in to or call, inherited from the person or added for it. */
export function AgentAccesses({ agent, onBrowser }: { agent: Agent; onBrowser: () => void }) {
	const access = useAccess();
	const [own, setOwn] = useState<AgentAccess | null>(null);
	const [error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[note, setNote] = useState('');
	const mcp = agent.harness?.mcp ?? [];
	const load = () => api<AgentAccess>(`/agents/${agent.id}/access`).then(setOwn, (e: Error) => setError(e.message));
	useEffect(() => {
		void load();
	}, [agent.id, access.view]);
	const call = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError('');
		try {
			await fn();
			await load();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const login = async (server: string) => {
		setError('');
		setNote('');
		try {
			await api(`/agents/${agent.id}/mcp/${server}/login`, { method: 'POST' });
			setNote(
				`Se abrió el navegador del agente con el inicio de sesión de «${server}». Complétalo ahí; al terminar, la sesión queda guardada.`,
			);
			onBrowser();
		} catch (e) {
			setError((e as Error).message);
		}
	};
	// Variables the approved MCP servers need (${NAME} in their headers or environment).
	const used = new Set(
		mcp.flatMap((s) =>
			[...s.headers, ...s.env].flatMap((p) => [...p.value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1])),
		),
	);
	const keys = access.view?.keys ?? [];
	const missing = [...used].filter(
		(n) => !keys.some((k) => k.name === n && k.agents.includes(agent.id)) && !own?.conflicts.some((s) => s.name === n),
	);
	return (
		<div className="min-w-0">
			{(error || access.error) && (
				<p role="alert" className="error mb-4">
					{error || access.error}
				</p>
			)}
			{note && (
				<p role="status" className="callout mb-4 text-xs">
					{note}
				</p>
			)}
			<Vault agents={[]} scope={agent} />
			<McpSection agents={[]} access={access} scope={agent} onLogin={(s) => void login(s)}>
				{mcp.length > 0 && (
					<div className="mt-4 grid gap-2">
						<h3 className="!m-0 text-sm">Del harness</h3>
						<p className="muted small">Se aprueban en Automejora. Si un nombre se repite, gana el del harness.</p>
						<ul className="grid gap-2">
							{mcp.map((s) => (
								<li key={s.name} className="row wrap items-center gap-3 rounded-md border p-3 text-sm">
									<div className="min-w-0 flex-1">
										<strong>{s.name}</strong> <Badge variant="outline">harness</Badge>{' '}
										<span className="muted small">
											· {s.transport === 'http' ? s.url : `${s.command} ${s.args.join(' ')}`}
										</span>
										<p className="muted small">{s.description}</p>
									</div>
									{s.oauth && (
										<Button size="sm" variant="outline" disabled={busy} onClick={() => void login(s.name)}>
											Iniciar sesión
										</Button>
									)}
								</li>
							))}
						</ul>
					</div>
				)}
			</McpSection>
			<KeysSection agents={[]} access={access} scope={agent}>
				{own?.conflicts.length ? (
					<div className="mt-4 grid gap-2 rounded-md border border-warning/40 p-3">
						<h3 className="!m-0 text-sm">Por resolver</h3>
						<p className="muted small">
							Al pasar las credenciales de cada agente a tus API Keys, estas tenían otro valor en otro de tus agentes.
							Este agente sigue usando el suyo hasta que decidas cuál queda como tuyo (el elegido se concede a los
							agentes que la tenían).
						</p>
						<ul className="grid gap-1 text-sm">
							{own.conflicts.map((s) => (
								<li key={s.name} className="row wrap items-center gap-3">
									<code>{s.name}</code>
									<span className="muted small">actualizada {ago(s.updated_at)}</span>
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() =>
											confirm(
												`¿Quedarte con el ${s.name} de este agente como tuyo? Los demás agentes que la tenían usarán este valor.`,
											) && void call(() => api(`/agents/${agent.id}/secrets/${s.name}/resolve`, { method: 'POST' }))
										}
									>
										Quedarme con éste
									</Button>
									<DeleteButton
										disabled={busy}
										onClick={() =>
											confirm(`¿Borrar el ${s.name} de este agente?`) &&
											void call(() => api(`/agents/${agent.id}/secrets/${s.name}`, { method: 'DELETE' }))
										}
									/>
								</li>
							))}
						</ul>
					</div>
				) : null}
				{missing.map((n) => (
					<p key={n} className="error small mt-2">
						Falta {n}: la usa un servidor MCP aprobado. Activa o agrega una API Key con ese nombre.
					</p>
				))}
			</KeysSection>
		</div>
	);
}
