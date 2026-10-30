// An agent's MCP servers, CLI tools and credentials (owner only). Servers and tools are part of the
// approved harness (changed through Automejora); credentials are set here and never shown again.
import { useEffect, useState } from 'react';
import { api, ago, type Agent } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Secret = { name: string; updated_at: number };

export function AgentTools({ agent, onBrowser }: { agent: Agent; onBrowser: () => void }) {
	const [secrets, setSecrets] = useState<Secret[] | null>(null);
	const [name, setName] = useState(''),
		[value, setValue] = useState('');
	const [error, setError] = useState(''),
		[busy, setBusy] = useState(false),
		[note, setNote] = useState('');
	const mcp = agent.harness?.mcp ?? [],
		installs = agent.harness?.installs ?? [];
	const call = async (fn: () => Promise<{ secrets: Secret[] }>) => {
		setBusy(true);
		setError('');
		try {
			setSecrets((await fn()).secrets);
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		void call(() => api(`/agents/${agent.id}/secrets`));
	}, [agent.id]);
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
				<h2>Servidores MCP</h2>
				<p className="muted">
					Herramientas externas que el agente puede usar (tickets, repositorios, documentos…). Se agregan o quitan en
					Automejora y se aplican al aprobar.
				</p>
				{mcp.length ? (
					<ul className="grid gap-2">
						{mcp.map((s) => (
							<li key={s.name} className="row wrap items-center gap-3 rounded-md border p-3 text-sm">
								<div className="min-w-0 flex-1">
									<strong>{s.name}</strong>{' '}
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
				) : (
					<p className="muted small">Sin servidores MCP.</p>
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
			<section className="grid min-w-0 gap-3" aria-label="Credenciales">
				<h2>Credenciales</h2>
				<p className="muted">
					Tokens y llaves para las herramientas de este agente (por ejemplo <code>GITHUB_TOKEN</code>). Llegan a su
					computadora como variables de entorno y los MCP los usan como <code>{'${NOMBRE}'}</code>. Se guardan cifrados
					y no se vuelven a mostrar. El agente puede leerlos: usa tokens con los permisos mínimos.
				</p>
				{secrets === null ? (
					<p className="muted">Cargando…</p>
				) : secrets.length ? (
					<ul className="grid gap-1 text-sm">
						{secrets.map((s) => (
							<li key={s.name} className="row items-center gap-3">
								<code>{s.name}</code>
								<span className="muted small">actualizada {ago(s.updated_at)}</span>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => {
										if (confirm(`¿Borrar ${s.name}? Las herramientas que la usan dejarán de autenticarse.`))
											void call(() => api(`/agents/${agent.id}/secrets/${s.name}`, { method: 'DELETE' }));
									}}
								>
									Borrar
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="muted small">Sin credenciales.</p>
				)}
				{[...used]
					.filter((n) => !secrets?.some((s) => s.name === n))
					.map((n) => (
						<p key={n} className="error small">
							Falta {n}: la usa un servidor MCP aprobado.
						</p>
					))}
				<form
					className="row wrap gap-2"
					onSubmit={async (e) => {
						e.preventDefault();
						if (
							await call(() =>
								api(`/agents/${agent.id}/secrets/${encodeURIComponent(name.trim().toUpperCase())}`, {
									method: 'PUT',
									body: { value },
								}),
							)
						) {
							setName('');
							setValue('');
						}
					}}
				>
					<Input
						aria-label="Nombre"
						className="max-w-56"
						value={name}
						onChange={(e) => setName(e.target.value.toUpperCase())}
						placeholder="GITHUB_TOKEN"
						autoComplete="off"
						spellCheck={false}
					/>
					<Input
						aria-label="Valor"
						className="max-w-80"
						type="password"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder="Valor (se guarda cifrado)"
						autoComplete="new-password"
					/>
					<Button disabled={busy || !name.trim() || !value}>Guardar credencial</Button>
				</form>
				<p className="muted small">
					Guardar con un nombre existente reemplaza su valor. Aplica a las tareas que empiecen después.
				</p>
			</section>
		</div>
	);
}
