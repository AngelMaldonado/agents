// An agent's MCP servers, CLI tools and accesses (owner only). The harness' servers and tools are
// approved through Automejora; the owner's own API Keys and MCP servers (#24) are granted here or in
// Configuración → Accesos. What the migration could not move (conflicts) is resolved here.
import { useEffect, useState } from 'react';
import { api, ago, type AccessKey, type AccessMcp, type AccessView, type Agent } from './api';
import { Badge } from '@/components/ui/badge';
import { SectionHead } from '@/components/access-ui';
import { Button } from '@/components/ui/button';
import { DeleteButton } from '@/components/actions';

type Secret = { name: string; updated_at: number };
type AgentAccess = AccessView & { conflicts: Secret[] };

export function AgentTools({ agent, onBrowser }: { agent: Agent; onBrowser: () => void }) {
	const [access, setAccess] = useState<AgentAccess | null>(null);
	const [error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[note, setNote] = useState('');
	const mcp = agent.harness?.mcp ?? [],
		installs = agent.harness?.installs ?? [];
	const load = () => api<AgentAccess>(`/agents/${agent.id}/access`).then(setAccess, (e: Error) => setError(e.message));
	useEffect(() => {
		void load();
	}, [agent.id]);
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
	const toggle = (kind: 'keys' | 'mcp', item: AccessKey | AccessMcp) =>
		call(() =>
			api(`/access/${kind}/${item.id}/grants`, {
				method: 'PUT',
				body: {
					agents: item.agents.includes(agent.id)
						? item.agents.filter((a) => a !== agent.id)
						: [...item.agents, agent.id],
				},
			}),
		);
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
	const used = new Set([
		...mcp.flatMap((s) =>
			[...s.headers, ...s.env].flatMap((p) => [...p.value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1])),
		),
	]);
	return (
		<div className="grid min-w-0 gap-8">
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			{note && (
				<p role="status" className="callout text-xs">
					{note}
				</p>
			)}
			<section className="grid min-w-0 gap-3" aria-label="Servidores MCP">
				<SectionHead
					title="Servidores MCP"
					security="Los secretos de tus servidores llegan al agente como marcador que la plataforma cambia sólo hacia el dominio del servidor. Quitarle un servidor con OAuth cierra su sesión en su siguiente tarea."
				/>
				<p className="muted">
					Los del harness se cambian en Automejora; los tuyos se conceden aquí. Si un nombre se repite, gana el del
					harness.
				</p>
				{mcp.length > 0 && (
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
				)}
				{access?.mcp.length ? (
					<ul className="grid gap-2">
						{access.mcp.map((m) => {
							const on = m.agents.includes(agent.id);
							return (
								<li key={m.id} className="row wrap items-center gap-3 rounded-md border p-3 text-sm">
									<label className="chip !mr-0 min-w-0 flex-1">
										<input type="checkbox" checked={on} disabled={busy} onChange={() => void toggle('mcp', m)} />
										<span className="min-w-0">
											<strong>{m.name}</strong>{' '}
											<span className="muted small">
												· {m.transport === 'http' ? m.url : `${m.command} ${m.args.join(' ')}`}
											</span>
											{m.description && <span className="muted small block">{m.description}</span>}
										</span>
									</label>
									{on && m.oauth && !mcp.some((s) => s.name === m.name) && (
										<Button size="sm" variant="outline" disabled={busy} onClick={() => void login(m.name)}>
											Iniciar sesión
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				) : (
					!mcp.length && (
						<p className="muted small">Sin servidores MCP. Registra los tuyos en Configuración → Accesos.</p>
					)
				)}
			</section>
			<section className="grid min-w-0 gap-3" aria-label="Herramientas instaladas">
				<h2>Herramientas de línea de comandos</h2>
				<p className="muted">
					Se instalan en la computadora del agente la primera vez que arranca con esta lista y quedan en su PATH. Se
					cambian en Automejora.
				</p>
				{installs.length ? (
					<ul className="grid gap-1 text-sm">
						{installs.map((i) => (
							<li key={`${i.kind}:${i.spec}`}>
								<code>{i.kind === 'binary' ? i.name : i.spec}</code>{' '}
								<span className="muted small">
									{i.kind === 'npm'
										? 'npm'
										: i.kind === 'uv'
											? 'Python (uv)'
											: `binario · sha256 ${i.sha256?.slice(0, 12)}…`}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="muted small">Sin herramientas adicionales.</p>
				)}
			</section>
			<section className="grid min-w-0 gap-3" aria-label="API Keys">
				<SectionHead
					title="API Keys"
					security="Las que tienen dominios le llegan al agente como marcador y la plataforma pone el valor sólo hacia esos dominios; las de «valor real» las puede leer. Aplican a las tareas que empiecen después."
				/>
				<p className="muted">Tus keys concedidas a este agente; se registran en Configuración → Accesos.</p>
				{access && !access.proxyReady && access.keys.some((k) => !k.expose_real) && (
					<p className="callout text-xs">
						Esta instancia todavía no tiene el proxy de salida: las keys con dominios no le llegan al agente.
					</p>
				)}
				{access === null ? (
					<p className="muted">Cargando…</p>
				) : access.keys.length ? (
					<ul className="grid gap-1 text-sm">
						{access.keys.map((k) => (
							<li key={k.id}>
								<label className="chip !mr-0">
									<input
										type="checkbox"
										checked={k.agents.includes(agent.id)}
										disabled={busy}
										onChange={() => void toggle('keys', k)}
									/>
									<code>{k.name}</code>
									{k.expose_real ? (
										<Badge variant="outline" className="border-danger/40 text-danger">
											valor real
										</Badge>
									) : (
										<span className="muted small">{k.domains.join(', ')}</span>
									)}
								</label>
							</li>
						))}
					</ul>
				) : (
					<p className="muted small">Sin API Keys. Regístralas en Configuración → Accesos.</p>
				)}
				{access?.conflicts.length ? (
					<div className="grid gap-2 rounded-md border border-warning/40 p-3">
						<h3 className="!m-0 text-sm">Por resolver</h3>
						<p className="muted small">
							Al pasar las credenciales de cada agente a tus API Keys, estas tenían otro valor en otro de tus agentes.
							Este agente sigue usando el suyo hasta que decidas cuál queda como tuyo (el elegido se concede a los
							agentes que la tenían).
						</p>
						<ul className="grid gap-1 text-sm">
							{access.conflicts.map((s) => (
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
				{access &&
					[...used]
						.filter(
							(n) =>
								!access.keys.some((k) => k.name === n && k.agents.includes(agent.id)) &&
								!access.conflicts.some((s) => s.name === n),
						)
						.map((n) => (
							<p key={n} className="error small">
								Falta {n}: la usa un servidor MCP aprobado. Concede una API Key con ese nombre.
							</p>
						))}
			</section>
		</div>
	);
}
