// Each person's own: provider keys (write-only) and site logins for their agents (write-only).
import { useEffect, useState } from 'react';
import { api, ago, type Agent, type Credential } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type KeyRow = { provider: 'openai'; last4: string; updated_at: number };
type ProxyRow = { url: string; last4: string; updated_at: number };
type Check = { total: number; catalog: { id: string; label: string; served: boolean }[] };

/** Configuración → GPT: the person's own CLIProxyAPI, or their OpenAI key. Secrets are stored encrypted. */
export function ProviderSettings() {
	return (
		<>
			<Proxy />
			<Keys />
		</>
	);
}

/**
 * Configuración → Accesos, in three clear kinds: logins for web pages (the person's vault, granted
 * to agents), MCP servers, and API keys for CLI tools. The last two are still each agent's own
 * (its harness and its secrets); making them the person's, granted like the vault, is Bubble
 * agents #24.
 */
export function Accesses({ agents }: { agents: Agent[] }) {
	return (
		<>
			<Vault agents={agents} />
			<section className="panel">
				<h2>Servidores MCP</h2>
				<p className="muted">
					Herramientas externas que un agente usa por MCP (tickets, repositorios, documentos…). Por ahora cada agente
					tiene los suyos: se agregan en su Automejora y se inicia sesión en su Configuración → Herramientas.
					Registrarlos aquí una vez y concederlos a tus agentes, como los accesos a sitios, viene después.
				</p>
			</section>
			<section className="panel">
				<h2>API Keys</h2>
				<p className="muted">
					Tokens para las herramientas de línea de comandos de un agente (por ejemplo <code>GITHUB_TOKEN</code>). Por
					ahora son de cada agente: se guardan en su Configuración → Herramientas y le llegan como variables de entorno.
					Guardarlas aquí una vez y concederlas a tus agentes viene después.
				</p>
			</section>
		</>
	);
}

function Proxy() {
	const [proxy, setProxy] = useState<ProxyRow | null>(null);
	const [url, setUrl] = useState('');
	const [key, setKey] = useState('');
	const [check, setCheck] = useState<Check | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		api('/keys').then((r) => {
			setProxy(r.proxy);
			if (r.proxy) setUrl(r.proxy.url);
		});
	}, []);
	const run = async (fn: () => Promise<any>) => {
		setBusy(true);
		setError('');
		try {
			await fn();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="panel">
			<h2>Tu CLIProxyAPI</h2>
			<p className="muted">
				Si tienes un CLIProxyAPI con tu cuenta de GPT, todas tus tareas saldrán por él y la key de abajo no hace falta.
				La key no se vuelve a mostrar; los agentes nunca la ven.
			</p>
			<form
				className="form"
				onSubmit={(e) => {
					e.preventDefault();
					void run(async () => {
						const r = await api('/proxy', { method: 'PUT', body: { url, key } });
						setProxy(r.proxy);
						setCheck(r.check);
						setKey('');
					});
				}}
			>
				<div className="field-list">
					<label className="field">
						<span>URL del proxy</span>
						<Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://proxy.ejemplo.com" />
					</label>
					<label className="field">
						<span>API key del proxy</span>
						<Input
							type="password"
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder={proxy ? `Guardada · termina en …${proxy.last4}` : 'API key'}
							autoComplete="off"
						/>
					</label>
					<div className="field-actions row wrap">
						<Button disabled={busy || !url.trim() || !key.trim()}>
							{busy ? 'Probando…' : proxy ? 'Reemplazar' : 'Guardar'}
						</Button>
						{proxy && (
							<>
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => run(async () => setCheck((await api('/proxy/test', { method: 'POST' })).check))}
								>
									Probar
								</Button>
								<Button
									type="button"
									variant="ghost"
									disabled={busy}
									onClick={() =>
										run(async () => {
											await api('/proxy', { method: 'DELETE' });
											setProxy(null);
											setCheck(null);
										})
									}
								>
									Quitar
								</Button>
							</>
						)}
					</div>
				</div>
				{proxy && (
					<p className="muted small">
						En uso: {proxy.url} · key …{proxy.last4} · {ago(proxy.updated_at)}
					</p>
				)}
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				{check && (
					<div className="rounded-md border bg-muted/30 p-4 text-xs">
						<p className="ok mb-2">Conectó: el proxy sirve {check.total} modelos.</p>
						{check.catalog.map((m) => (
							<div key={m.id} className={m.served ? 'ok' : 'muted'}>
								{m.served ? '✓' : '—'} {m.label} <code>{m.id.split('/')[1]}</code>
								{!m.served && ' — tu proxy no lo sirve'}
							</div>
						))}
					</div>
				)}
				<p className="muted small">
					La URL la abre el servidor en reko-3, no tu navegador. Usa una IP de la LAN o tailnet; <code>localhost</code>{' '}
					de tu Mac no sirve.
				</p>
			</form>
		</section>
	);
}

function Keys() {
	const [keys, setKeys] = useState<KeyRow[]>([]);
	useEffect(() => {
		api('/keys').then((r) => setKeys(r.keys));
	}, []);
	return (
		<section className="panel">
			<h2>O tu API key de OpenAI</h2>
			<p className="muted">
				Se usa sólo si no tienes un CLIProxyAPI propio. Las tareas consumen tu cuenta. La key no se vuelve a mostrar, ni
				siquiera al admin.
			</p>
			<KeyRowForm
				provider="openai"
				label="OpenAI (GPT)"
				hint="sk-proj-…"
				row={keys.find((k) => k.provider === 'openai')}
				onSaved={setKeys}
			/>
		</section>
	);
}

function KeyRowForm({
	provider,
	label,
	hint,
	row,
	onSaved,
}: {
	provider: string;
	label: string;
	hint: string;
	row?: KeyRow;
	onSaved: (keys: KeyRow[]) => void;
}) {
	const [value, setValue] = useState('');
	const [error, setError] = useState('');
	return (
		<form
			className="key-row"
			onSubmit={async (e) => {
				e.preventDefault();
				setError('');
				try {
					const r = await api(`/keys/${provider}`, { method: 'PUT', body: { key: value } });
					setValue('');
					onSaved(r.keys);
				} catch (err) {
					setError((err as Error).message);
				}
			}}
		>
			<div className="key-label">
				<b className="font-medium">{label}</b>
				<div className="muted small mt-1">{row ? `Guardada · …${row.last4} · ${ago(row.updated_at)}` : 'Sin key'}</div>
			</div>
			<Input
				type="password"
				aria-label={`API key de ${label}`}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={hint}
				autoComplete="off"
			/>
			<Button disabled={!value.trim()}>{row ? 'Reemplazar' : 'Guardar'}</Button>
			{row && (
				<Button
					type="button"
					variant="ghost"
					onClick={async () => onSaved((await api(`/keys/${provider}`, { method: 'DELETE' })).keys)}
				>
					Quitar
				</Button>
			)}
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
		</form>
	);
}

function Vault({ agents }: { agents: Agent[] }) {
	const [creds, setCreds] = useState<Credential[]>([]);
	const [uses, setUses] = useState<any[]>([]);
	const [form, setForm] = useState({ name: '', loginUrl: '', username: '', password: '' });
	const [error, setError] = useState('');
	const load = () =>
		api('/vault').then((r) => {
			setCreds(r.credentials);
			setUses(r.uses);
		});
	useEffect(() => {
		void load();
	}, []);
	const toggle = async (c: Credential, agentId: number) => {
		const next = c.agents.includes(agentId) ? c.agents.filter((a) => a !== agentId) : [...c.agents, agentId];
		setCreds((await api(`/vault/${c.id}/grants`, { method: 'PUT', body: { agents: next } })).credentials);
	};
	return (
		<section className="panel">
			<h2>Accesos a sitios</h2>
			<p className="muted">
				Usuarios y contraseñas de páginas web. El agente conoce sólo el nombre: <code>agents-login nombre</code> llena
				el formulario sin mostrar el secreto al modelo. Sólo los agentes autorizados pueden usar el acceso, y sólo en su
				dominio.
			</p>
			<Table className="vault">
				<TableHeader>
					<TableRow>
						<TableHead>Nombre</TableHead>
						<TableHead>Sitio</TableHead>
						<TableHead>Agentes con acceso</TableHead>
						<TableHead>
							<span className="sr-only">Acciones</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{creds.map((c) => (
						<TableRow key={c.id}>
							<TableCell>
								<code>{c.name}</code>
							</TableCell>
							<TableCell className="text-xs">{c.origin}</TableCell>
							<TableCell>
								{agents.map((a) => (
									<label key={a.id} className="chip">
										<input type="checkbox" checked={c.agents.includes(a.id)} onChange={() => toggle(c, a.id)} />
										{a.name}
									</label>
								))}
								{!agents.length && <span className="muted small">Crea un agente primero</span>}
							</TableCell>
							<TableCell>
								<Button
									variant="danger-ghost"
									size="sm"
									onClick={async () =>
										confirm(`¿Borrar ${c.name}?`) &&
										setCreds((await api(`/vault/${c.id}`, { method: 'DELETE' })).credentials)
									}
								>
									Borrar
								</Button>
							</TableCell>
						</TableRow>
					))}
					{!creds.length && (
						<TableRow>
							<TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
								Sin accesos guardados.
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
			<form
				className="form mt-6 border-t pt-5"
				onSubmit={async (e) => {
					e.preventDefault();
					setError('');
					try {
						setCreds((await api('/vault', { body: form })).credentials);
						setForm({ name: '', loginUrl: '', username: '', password: '' });
					} catch (err) {
						setError((err as Error).message);
					}
				}}
			>
				<h3 className="!mt-0 !mb-0">Agregar o reemplazar un acceso</h3>
				<div className="field-list">
					<label className="field">
						<span>Nombre del acceso</span>
						<Input
							placeholder="p. ej. proveedor"
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>URL de inicio de sesión</span>
						<Input
							placeholder="https://sitio.com/login"
							value={form.loginUrl}
							onChange={(e) => setForm({ ...form, loginUrl: e.target.value })}
						/>
					</label>
					<label className="field">
						<span>Usuario</span>
						<Input
							value={form.username}
							onChange={(e) => setForm({ ...form, username: e.target.value })}
							autoComplete="off"
						/>
					</label>
					<label className="field">
						<span>Contraseña</span>
						<Input
							type="password"
							value={form.password}
							onChange={(e) => setForm({ ...form, password: e.target.value })}
							autoComplete="new-password"
						/>
					</label>
				</div>
				<div className="field-actions">
					<Button>Guardar acceso</Button>
				</div>
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<p className="muted small">
					Sin segundo factor por ahora: si un sitio lo pide, el agente se declara atascado y lo salta.
				</p>
			</form>
			<h3>Últimos usos</h3>
			<UsesTable uses={uses} />
		</section>
	);
}

export function UsesTable({ uses, showPerson }: { uses: any[]; showPerson?: boolean }) {
	return (
		<Table className="uses">
			<TableBody>
				{uses.map((u) => (
					<TableRow key={u.id}>
						<TableCell className="text-xs">{new Date(u.at).toLocaleString('es-MX')}</TableCell>
						{showPerson && <TableCell>{u.person}</TableCell>}
						<TableCell>
							<code>{u.credential_name}</code>
						</TableCell>
						<TableCell className="text-xs">tarea #{u.task_id}</TableCell>
						<TableCell className={u.ok ? 'ok' : 'error'}>{u.ok ? 'entregada' : 'negada'}</TableCell>
						<TableCell className="text-xs text-muted-foreground">{u.detail}</TableCell>
					</TableRow>
				))}
				{!uses.length && (
					<TableRow>
						<TableCell colSpan={showPerson ? 6 : 5} className="py-6 text-muted-foreground">
							Nadie ha usado un acceso.
						</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);
}
