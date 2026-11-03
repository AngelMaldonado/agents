// Each person's own: provider keys (write-only) and site logins for their agents (write-only).
import { useEffect, useState } from 'react';
import { api, ago, type Agent, type Credential } from './api';
import { Button } from '@/components/ui/button';
import { DeleteButton, EditButton, FormActions, SaveButton, useSaving } from '@/components/actions';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KeysSection, McpSection, useAccess } from './Access';
import { AddMenu, AgentPicker, FormDialog, GrantToggle, SectionHead } from '@/components/access-ui';

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
 * Configuración → Accesos, in three clear kinds, all the person's own and granted to their agents:
 * logins for web pages (the vault), MCP servers and API Keys for CLI tools (Access.tsx, #24).
 */
export function Accesses({ agents }: { agents: Agent[] }) {
	const access = useAccess();
	return (
		<>
			<Vault agents={agents} />
			{access.error && (
				<p role="alert" className="error mb-4">
					{access.error}
				</p>
			)}
			<McpSection agents={agents} access={access} />
			<KeysSection agents={agents} access={access} />
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
	const saving = useSaving();
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
			<SectionHead
				title="Tu CLIProxyAPI"
				security="La key se guarda cifrada y no se vuelve a mostrar. La usa el servidor; los agentes nunca la ven."
			/>
			<p className="muted">Si lo tienes, todas tus tareas salen por él y la key de OpenAI no hace falta.</p>
			<form
				className="form"
				onSubmit={(e) => {
					e.preventDefault();
					void run(() =>
						saving.run(async () => {
							const r = await api('/proxy', { method: 'PUT', body: { url, key } });
							setProxy(r.proxy);
							setCheck(r.check);
							setKey('');
						}),
					);
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
						<SaveButton state={saving.state} disabled={busy || !url.trim() || !key.trim()}>
							{proxy ? 'Reemplazar' : 'Guardar'}
						</SaveButton>
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
								<DeleteButton
									label="Quitar"
									type="button"

									disabled={busy}
									onClick={() =>
										run(async () => {
											await api('/proxy', { method: 'DELETE' });
											setProxy(null);
											setCheck(null);
										})
									}
								/>
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
			<SectionHead
				title="O tu API key de OpenAI"
				security="Se guarda cifrada y no se vuelve a mostrar, ni siquiera al admin. Los agentes nunca la ven."
			/>
			<p className="muted">Sólo si no tienes CLIProxyAPI; las tareas consumen tu cuenta.</p>
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
	const saving = useSaving();
	const [error, setError] = useState('');
	return (
		<form
			className="key-row"
			onSubmit={async (e) => {
				e.preventDefault();
				setError('');
				try {
					await saving.run(async () => {
						const r = await api(`/keys/${provider}`, { method: 'PUT', body: { key: value } });
						setValue('');
						onSaved(r.keys);
					});
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
			<SaveButton state={saving.state} disabled={!value.trim()}>
				{row ? 'Reemplazar' : 'Guardar'}
			</SaveButton>
			{row && (
				<DeleteButton
					label="Quitar"
					type="button"

					onClick={async () => onSaved((await api(`/keys/${provider}`, { method: 'DELETE' })).keys)}
				/>
			)}
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
		</form>
	);
}

/** scope: one agent's settings, as in KeysSection (a switch per access; a new one is granted to it alone). */
export function Vault({ agents, scope }: { agents: Agent[]; scope?: Agent }) {
	const [creds, setCreds] = useState<Credential[]>([]);
	const [uses, setUses] = useState<any[]>([]);
	const empty = { name: '', loginUrl: '', username: '', password: '' };
	const [form, setForm] = useState(empty);
	const [adding, setAdding] = useState(false);
	const saving = useSaving();
	const [error, setError] = useState('');
	const load = () =>
		api('/vault').then((r) => {
			setCreds(r.credentials);
			setUses(r.uses);
		});
	useEffect(() => {
		void load();
	}, []);
	// From an agent's Accesos: only the ones it uses.
	const shown = scope ? creds.filter((c) => c.agents.includes(scope.id)) : creds;
	const grant = async (c: Credential, next: number[]) =>
		setCreds((await api(`/vault/${c.id}/grants`, { method: 'PUT', body: { agents: next } })).credentials);
	const open = (c: Credential | null) => {
		setError('');
		setForm(c ? { ...empty, name: c.name, loginUrl: c.login_url } : empty);
		setAdding(true);
	};
	return (
		<section className="panel">
			<SectionHead
				title="Accesos a sitios"
				onAdd={() => open(null)}
				action={
					scope && (
						<AddMenu
							options={creds
								.filter((c) => !c.agents.includes(scope.id))
								.map((c) => ({ id: c.id, label: c.name, detail: c.origin }))}
							onPick={(id) => {
								const c = creds.find((x) => x.id === id)!;
								void grant(c, [...c.agents, scope.id]);
							}}
							onNew={() => open(null)}
							newLabel="Nuevo acceso sólo para este agente"
						/>
					)
				}
				security={
					<>
						Usuario y contraseña se guardan cifrados. El agente sólo conoce el nombre: <code>agents-login nombre</code>{' '}
						llena el formulario sin mostrarle el secreto, y sólo en el dominio del acceso. Quitárselo borra sus cookies
						de ese sitio. Sin segundo factor por ahora: si un sitio lo pide, el agente pide ayuda.
					</>
				}
			/>
			<p className="muted">
				{scope
					? 'Los que usa este agente: agrega uno tuyo o crea uno sólo para él; apagarlo se lo quita.'
					: 'Usuarios y contraseñas de páginas web para tus agentes.'}
			</p>
			<Table className="vault">
				<TableHeader>
					<TableRow>
						<TableHead>Nombre</TableHead>
						<TableHead>Sitio</TableHead>
						{!scope && <TableHead>Agentes</TableHead>}
						<TableHead className={scope ? 'text-right' : undefined}>
							{scope ? 'Acciones' : <span className="sr-only">Acciones</span>}
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{shown.map((c) => (
						<TableRow key={c.id}>
							<TableCell>
								<code>{c.name}</code>
							</TableCell>
							<TableCell className="text-xs">{c.origin}</TableCell>
							{!scope && (
								<TableCell>
									<AgentPicker agents={agents} value={c.agents} onChange={(next) => void grant(c, next)} />
								</TableCell>
							)}
							<TableCell className="text-right whitespace-nowrap">
								<div className="inline-flex items-center justify-end gap-1">
									<EditButton onClick={() => open(c)} />
									{/* From an agent, deleting would take it from every agent: that stays in Configuración. */}
									{!scope && (
										<DeleteButton
											onClick={async () =>
												confirm(`¿Borrar ${c.name}?`) &&
												setCreds((await api(`/vault/${c.id}`, { method: 'DELETE' })).credentials)
											}
										/>
									)}
									{/* Assigned here: switching it off takes it away from this agent (and from the table). */}
									{scope && (
										<GrantToggle
											on
											what={c.name}
											onChange={(on) =>
												void grant(c, on ? [...c.agents, scope.id] : c.agents.filter((a) => a !== scope.id))
											}
										/>
									)}
								</div>
							</TableCell>
						</TableRow>
					))}
					{!shown.length && (
						<TableRow>
							<TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
								{scope ? 'Este agente no usa accesos a sitios.' : 'Sin accesos guardados.'}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title={creds.some((c) => c.name === form.name) ? `Reemplazar ${form.name}` : 'Agregar un acceso'}
				description="Guardar con un nombre existente lo reemplaza; el usuario y la contraseña se vuelven a escribir."
			>
				<form
					className="form"
					onSubmit={async (e) => {
						e.preventDefault();
						setError('');
						try {
							await saving.run(
								async () => {
									let list: Credential[] = (await api('/vault', { body: form })).credentials;
									// From an agent's settings, a new access is granted to that agent (and only to it).
									const c = scope && list.find((x) => x.name.toLowerCase() === form.name.trim().toLowerCase());
									if (c && !c.agents.includes(scope.id))
										list = (
											await api(`/vault/${c.id}/grants`, { method: 'PUT', body: { agents: [...c.agents, scope.id] } })
										).credentials;
									setCreds(list);
								},
								{ hold: true },
							);
							setAdding(false);
						} catch (err) {
							setError((err as Error).message);
						}
					}}
				>
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
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<FormActions
						submitLabel="Guardar acceso"
						disabled={false}
						state={saving.state}
						onCancel={() => setAdding(false)}
					/>
				</form>
			</FormDialog>
			{!scope && (
				<>
					<h3>Últimos usos</h3>
					<UsesTable uses={uses} />
				</>
			)}
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
