// Configuración → Accesos: a person's API Keys and MCP servers, granted to their agents (#24).
// Values are write-only: saved here, never shown again. A key with domains reaches an agent only as
// a placeholder; the egress proxy puts the value in requests to those domains.
import { useEffect, useState, type ReactNode } from 'react';
import { api, ago, type AccessKey, type AccessMcp, type AccessPair, type AccessView, type Agent } from './api';
import { Badge } from '@/components/ui/badge';
import { AddMenu, AgentPicker, FormDialog, GrantToggle, SectionHead, TestButton } from '@/components/access-ui';
import { Button } from '@/components/ui/button';
import { DeleteButton, EditButton, FormActions, useSaving } from '@/components/actions';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Suggestions for well-known services: the domains their CLIs and APIs call.
const SUGGESTIONS: { label: string; name: string; domains: string }[] = [
	{ label: 'GitHub', name: 'GITHUB_TOKEN', domains: 'api.github.com, github.com, uploads.github.com' },
	{ label: 'GitLab', name: 'GITLAB_TOKEN', domains: 'gitlab.com' },
	{ label: 'OpenAI', name: 'OPENAI_KEY', domains: 'api.openai.com' },
	{ label: 'Stripe', name: 'STRIPE_API_KEY', domains: 'api.stripe.com' },
	{ label: 'Linear', name: 'LINEAR_API_KEY', domains: 'api.linear.app' },
	{ label: 'Notion', name: 'NOTION_TOKEN', domains: 'api.notion.com' },
	{ label: 'Slack', name: 'SLACK_BOT_TOKEN', domains: 'slack.com' },
];

/** Shared by both sections: the view, and an action that reloads it or shows its error. */
export function useAccess() {
	const [view, setView] = useState<AccessView | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		api<AccessView>('/access').then(setView, (e: Error) => setError(e.message));
	}, []);
	const act = async (fn: () => Promise<AccessView>) => {
		setBusy(true);
		setError('');
		try {
			setView(await fn());
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	// A dialog's save: the same action, with the button's spinner and check (held before it closes).
	const saving = useSaving();
	const save = (fn: () => Promise<AccessView>) =>
		saving
			.run(
				async () => {
					if (!(await act(fn))) throw new Error('not saved');
				},
				{ hold: true },
			)
			.then(
				() => true,
				() => false,
			);
	return { view, error, busy, act, save, saveState: saving.state };
}

const realBadge = (
	<Badge variant="outline" className="border-danger/40 text-danger">
		valor real
	</Badge>
);

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<label className="field">
			<span>
				{label}
				{hint && <span className="muted small block font-normal">{hint}</span>}
			</span>
			{children}
		</label>
	);
}

type PairDraft = { name: string; value: string; secret: boolean; kept: boolean };
const draftPairs = (list: AccessPair[]): PairDraft[] =>
	list.map((p) => ({ name: p.name, value: p.value ?? '', secret: p.secret, kept: p.secret }));

function PairsEditor({
	label,
	pairs,
	onChange,
	namePlaceholder,
}: {
	label: string;
	pairs: PairDraft[];
	onChange: (next: PairDraft[]) => void;
	namePlaceholder: string;
}) {
	const set = (i: number, patch: Partial<PairDraft>) =>
		onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
	return (
		<div className="grid gap-2">
			{pairs.map((p, i) => (
				<div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] items-center gap-2">
					<Input
						aria-label={`Nombre de ${label}`}
						value={p.name}
						onChange={(e) => set(i, { name: e.target.value })}
						placeholder={namePlaceholder}
						spellCheck={false}
					/>
					<Input
						aria-label={`Valor de ${label}`}
						type={p.secret ? 'password' : 'text'}
						value={p.value}
						onChange={(e) => set(i, { value: e.target.value })}
						placeholder={p.secret && p.kept ? 'Guardado · sin cambios' : 'Valor'}
						autoComplete="off"
					/>
					<label className="chip !mr-0 text-xs">
						<input type="checkbox" checked={p.secret} onChange={(e) => set(i, { secret: e.target.checked })} />
						Secreto
					</label>
					<DeleteButton label="Quitar" type="button" onClick={() => onChange(pairs.filter((_, j) => j !== i))} />
				</div>
			))}
			<div>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => onChange([...pairs, { name: '', value: '', secret: true, kept: false }])}
				>
					Agregar
				</Button>
			</div>
		</div>
	);
}

/**
 * scope: one agent's settings (its Accesos tab): a switch grants each key to it, and a new key is
 * granted to it alone. Without scope, the person's settings: a picker of agents per key.
 */
export function KeysSection({
	agents,
	access,
	scope,
	children,
}: {
	agents: Agent[];
	access: ReturnType<typeof useAccess>;
	scope?: Agent;
	children?: ReactNode;
}) {
	const { view, busy, act, save, saveState } = access;
	const empty = { name: '', value: '', domains: '', exposeReal: false };
	const [form, setForm] = useState(empty);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<AccessKey | null>(null);
	// From an agent's Accesos: only what it uses, and a switch that grants or takes each one away.
	const keys = scope ? (view?.keys ?? []).filter((k) => k.agents.includes(scope.id)) : (view?.keys ?? []);
	const grantKey = (k: AccessKey, on: boolean) =>
		act(() =>
			api(`/access/keys/${k.id}/grants`, {
				method: 'PUT',
				body: { agents: on ? [...k.agents, scope!.id] : k.agents.filter((a) => a !== scope!.id) },
			}),
		);
	const start = (k: AccessKey | null) => {
		setEditing(k);
		setForm(k ? { name: k.name, value: '', domains: k.domains.join(', '), exposeReal: k.expose_real } : empty);
		setOpen(true);
	};
	return (
		<section className="panel">
			<SectionHead
				title="API Keys"
				onAdd={() => start(null)}
				action={
					scope && (
						<AddMenu
							options={(view?.keys ?? [])
								.filter((k) => !k.agents.includes(scope.id))
								.map((k) => ({
									id: k.id,
									label: k.name,
									detail: k.expose_real ? 'valor real' : k.domains.join(', '),
								}))}
							onPick={(id) => {
								const k = view!.keys.find((x) => x.id === id)!;
								void grantKey(k, true);
							}}
							onNew={() => start(null)}
							newLabel="Nueva API Key sólo para este agente"
						/>
					)
				}
				security={
					<>
						El valor se guarda cifrado y no se vuelve a mostrar. El agente recibe un marcador en la variable; la
						plataforma pone la key sólo en las peticiones HTTPS a sus dominios, así que no la ve y fuera de ellos no
						sirve. «Entregar el valor real» la deja legible para el agente.
					</>
				}
			/>
			<p className="muted">
				{scope
					? 'Las que usa este agente: agrega una tuya o crea una sólo para él; apagarla se la quita.'
					: 'Tokens para las herramientas de línea de comandos de tus agentes.'}
			</p>
			{view && !view.proxyReady && (
				<p className="callout mb-4 text-xs">
					Esta instancia aún no tiene el proxy de salida: las keys con dominios no llegan a los agentes.
				</p>
			)}
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Variable</TableHead>
						<TableHead>Dónde se usa</TableHead>
						{!scope && <TableHead>Agentes</TableHead>}
						<TableHead className={scope ? 'text-right' : undefined}>
							{scope ? 'Acciones' : <span className="sr-only">Acciones</span>}
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{keys.map((k: AccessKey) => (
						<TableRow key={k.id}>
							<TableCell>
								<code>{k.name}</code>
								<div className="muted small">{ago(k.updated_at)}</div>
							</TableCell>
							<TableCell className="text-xs whitespace-normal">
								{k.expose_real ? (
									<span className="flex flex-col items-start gap-1">
										{realBadge}
										{!k.domains.length && <span className="muted">Agrega sus dominios para protegerla.</span>}
									</span>
								) : (
									k.domains.join(', ')
								)}
							</TableCell>
							{!scope && (
								<TableCell>
									<AgentPicker
										agents={agents}
										value={k.agents}
										disabled={busy}
										onChange={(next) =>
											act(() => api(`/access/keys/${k.id}/grants`, { method: 'PUT', body: { agents: next } }))
										}
									/>
								</TableCell>
							)}
							<TableCell className="text-right whitespace-nowrap">
								<div className="inline-flex items-center justify-end gap-1">
									<EditButton onClick={() => start(k)} />
									{/* From an agent, deleting would take it from every agent: that stays in Configuración. */}
									{!scope && (
										<DeleteButton
											disabled={busy}
											onClick={() =>
												confirm(`¿Borrar ${k.name}? Los agentes que la usan la pierden desde su siguiente tarea.`) &&
												act(() => api(`/access/keys/${k.id}`, { method: 'DELETE' }))
											}
										/>
									)}
									{/* Assigned here: switching it off takes it away from this agent (and from the table). */}
									{scope && <GrantToggle on what={k.name} disabled={busy} onChange={(on) => void grantKey(k, on)} />}
								</div>
							</TableCell>
						</TableRow>
					))}
					{view && !keys.length && (
						<TableRow>
							<TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
								{scope ? 'Este agente no usa API Keys.' : 'Sin API Keys guardadas.'}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
			{children}
			<FormDialog open={open} onOpenChange={setOpen} title={editing ? `Editar ${editing.name}` : 'Agregar una API Key'}>
				<form
					className="form"
					onSubmit={async (e) => {
						e.preventDefault();
						const saved = await save(async () => {
							const view = await api<AccessView>('/access/keys', { body: form });
							// From an agent's settings, a new key is granted to that agent (and only to it).
							const k = scope && view.keys.find((x) => x.name.toUpperCase() === form.name.trim().toUpperCase());
							return k && !k.agents.includes(scope.id)
								? api<AccessView>(`/access/keys/${k.id}/grants`, {
										method: 'PUT',
										body: { agents: [...k.agents, scope.id] },
									})
								: view;
						});
						if (saved) setOpen(false);
					}}
				>
					<div className="field-list">
						<Field label="Variable" hint="Así la ven las herramientas">
							<Input
								value={form.name}
								disabled={!!editing}
								onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })}
								placeholder="GITHUB_TOKEN"
								autoComplete="off"
								spellCheck={false}
							/>
						</Field>
						<Field label="Valor" hint={editing ? 'Vacío: conserva el guardado' : undefined}>
							<Input
								type="password"
								value={form.value}
								onChange={(e) => setForm({ ...form, value: e.target.value })}
								placeholder={editing ? 'Sin cambios' : 'ghp_…'}
								autoComplete="new-password"
							/>
						</Field>
						<Field label="Dominios" hint="Separados por comas; *.ejemplo.com para subdominios">
							<div className="grid gap-2">
								<Input
									value={form.domains}
									onChange={(e) => setForm({ ...form, domains: e.target.value })}
									placeholder="api.github.com, github.com"
									spellCheck={false}
								/>
								<div className="flex flex-wrap gap-1">
									{SUGGESTIONS.map((s) => (
										<Button
											key={s.label}
											type="button"
											size="sm"
											variant="outline"
											className="h-6 px-2 text-2xs"
											onClick={() => setForm({ ...form, name: form.name || s.name, domains: s.domains })}
										>
											{s.label}
										</Button>
									))}
								</div>
							</div>
						</Field>
						<Field label="Valor real" hint="Para lo que no es HTTP">
							<label className="chip">
								<input
									type="checkbox"
									checked={form.exposeReal}
									onChange={(e) => setForm({ ...form, exposeReal: e.target.checked })}
								/>
								<span className={form.exposeReal ? 'danger' : 'muted'}>Entregar el valor real (el agente lo lee)</span>
							</label>
						</Field>
					</div>
					{access.error && (
						<p role="alert" className="error">
							{access.error}
						</p>
					)}
					<FormActions
						submitLabel={editing ? 'Guardar cambios' : 'Guardar key'}
						disabled={busy || !form.name.trim()}
						state={saveState}
						onCancel={() => setOpen(false)}
					/>
				</form>
			</FormDialog>
		</section>
	);
}

/** scope: as in KeysSection; onLogin signs the scoped agent in to an OAuth server it was granted. */
export function McpSection({
	agents,
	access,
	scope,
	onLogin,
	children,
}: {
	agents: Agent[];
	access: ReturnType<typeof useAccess>;
	scope?: Agent;
	onLogin?: (server: string) => void;
	children?: ReactNode;
}) {
	const { view, busy, act, save, saveState } = access;
	const empty = {
		name: '',
		description: '',
		transport: 'http' as 'http' | 'stdio',
		url: '',
		command: '',
		args: '',
		headers: [] as PairDraft[],
		env: [] as PairDraft[],
		domains: '',
		oauth: false,
		exposeReal: false,
	};
	const [form, setForm] = useState(empty);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<AccessMcp | null>(null);
	const servers = scope ? (view?.mcp ?? []).filter((m) => m.agents.includes(scope.id)) : (view?.mcp ?? []);
	const grantMcp = (m: AccessMcp, on: boolean) =>
		act(() =>
			api(`/access/mcp/${m.id}/grants`, {
				method: 'PUT',
				body: { agents: on ? [...m.agents, scope!.id] : m.agents.filter((a) => a !== scope!.id) },
			}),
		);
	const start = (m: AccessMcp | null) => {
		setEditing(m);
		setForm(
			m
				? {
						name: m.name,
						description: m.description,
						transport: m.transport,
						url: m.url ?? '',
						command: m.command ?? '',
						args: m.args.join(' '),
						headers: draftPairs(m.headers),
						env: draftPairs(m.env),
						domains: m.transport === 'stdio' ? m.domains.join(', ') : '',
						oauth: m.oauth,
						exposeReal: m.expose_real,
					}
				: empty,
		);
		setOpen(true);
	};
	const test = async (m: AccessMcp) => {
		const r = await api<{ tools: string[] }>(`/access/mcp/${m.id}/test`, { method: 'POST' });
		return `${r.tools.length} herramientas: ${r.tools.join(', ') || '—'}`;
	};
	const pairsOut = (list: PairDraft[]) =>
		list
			.filter((p) => p.name.trim())
			.map((p) => ({ name: p.name.trim(), secret: p.secret, value: p.value || undefined }));
	return (
		<section className="panel">
			<SectionHead
				title="Servidores MCP"
				onAdd={() => start(null)}
				action={
					scope && (
						<AddMenu
							options={(view?.mcp ?? [])
								.filter((m) => !m.agents.includes(scope.id))
								.map((m) => ({
									id: m.id,
									label: m.name,
									detail: m.transport === 'http' ? (m.url ?? '') : `${m.command} ${m.args.join(' ')}`,
								}))}
							onPick={(id) =>
								void grantMcp(
									view!.mcp.find((x) => x.id === id)!,
									true,
								)
							}
							onNew={() => start(null)}
							newLabel="Nuevo servidor sólo para este agente"
						/>
					)
				}
				security={
					<>
						Sus encabezados y variables secretos se guardan cifrados y llegan al agente como marcador que la plataforma
						cambia sólo hacia el dominio del servidor. Con OAuth, cada agente inicia sesión en su navegador; quitarle el
						servidor cierra esa sesión.
					</>
				}
			/>
			<p className="muted">
				{scope
					? 'Los que usa este agente: agrega uno tuyo o crea uno sólo para él; apagarlo se lo quita. Aparecen en su siguiente tarea.'
					: 'Herramientas externas para tus agentes; aparecen en su siguiente tarea.'}
			</p>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Servidor</TableHead>
						{!scope && <TableHead>Agentes</TableHead>}
						<TableHead className={scope ? 'text-right' : undefined}>
							{scope ? 'Acciones' : <span className="sr-only">Acciones</span>}
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{servers.map((m) => (
						<TableRow key={m.id}>
							<TableCell className="max-w-80 whitespace-normal">
								<div className="flex flex-wrap items-center gap-2">
									<code>{m.name}</code>
									{m.oauth && <Badge variant="outline">OAuth</Badge>}
									{m.expose_real && realBadge}
								</div>
								<div className="muted small truncate">
									{m.transport === 'http' ? m.url : `${m.command} ${m.args.join(' ')}`}
								</div>
								{m.description && <div className="muted small truncate">{m.description}</div>}
							</TableCell>
							{!scope && (
								<TableCell>
									<AgentPicker
										agents={agents}
										value={m.agents}
										disabled={busy}
										onChange={(next) =>
											act(() => api(`/access/mcp/${m.id}/grants`, { method: 'PUT', body: { agents: next } }))
										}
									/>
								</TableCell>
							)}
							<TableCell className="text-right whitespace-nowrap">
								<div className="inline-flex items-center justify-end gap-1">
									{scope && onLogin && m.oauth && (
										<Button size="sm" variant="outline" disabled={busy} onClick={() => onLogin(m.name)}>
											Iniciar sesión
										</Button>
									)}
									{m.transport === 'http' && !m.oauth && <TestButton run={() => test(m)} />}
									<EditButton onClick={() => start(m)} />
									{!scope && (
										<DeleteButton
											disabled={busy}
											onClick={() =>
												confirm(`¿Borrar ${m.name}? Sus agentes lo pierden y se cierra su sesión en él.`) &&
												act(() => api(`/access/mcp/${m.id}`, { method: 'DELETE' }))
											}
										/>
									)}
									{/* Assigned here: switching it off takes it away from this agent (and from the table). */}
									{scope && <GrantToggle on what={m.name} disabled={busy} onChange={(on) => void grantMcp(m, on)} />}
								</div>
							</TableCell>
						</TableRow>
					))}
					{view && !servers.length && (
						<TableRow>
							<TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
								{scope ? 'Este agente no usa servidores MCP tuyos.' : 'Sin servidores MCP guardados.'}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
			{children}
			<FormDialog
				open={open}
				onOpenChange={setOpen}
				title={editing ? `Editar ${editing.name}` : 'Agregar un servidor MCP'}
			>
				<form
					className="form"
					onSubmit={async (e) => {
						e.preventDefault();
						const body = {
							name: form.name.trim(),
							description: form.description,
							transport: form.transport,
							url: form.url,
							command: form.command,
							args: form.args.split(/\s+/).filter(Boolean),
							headers: pairsOut(form.headers),
							env: pairsOut(form.env),
							domains: form.domains,
							oauth: form.oauth,
							exposeReal: form.exposeReal,
						};
						const saved = await save(async () => {
							const view = await api<AccessView>('/access/mcp', { body });
							// From an agent's settings, a new server is granted to that agent (and only to it).
							const m = scope && view.mcp.find((x) => x.name.toLowerCase() === body.name.toLowerCase());
							return m && !m.agents.includes(scope.id)
								? api<AccessView>(`/access/mcp/${m.id}/grants`, {
										method: 'PUT',
										body: { agents: [...m.agents, scope.id] },
									})
								: view;
						});
						if (saved) setOpen(false);
					}}
				>
					<div className="field-list">
						<Field label="Nombre" hint="Minúsculas y guiones">
							<Input
								value={form.name}
								disabled={!!editing}
								onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })}
								placeholder="linear"
								spellCheck={false}
							/>
						</Field>
						<Field label="Descripción" hint="La lee el agente">
							<Input
								value={form.description}
								onChange={(e) => setForm({ ...form, description: e.target.value })}
								placeholder="Tickets del equipo"
							/>
						</Field>
						<Field label="Tipo">
							<div className="flex flex-wrap gap-3">
								{(['http', 'stdio'] as const).map((t) => (
									<label key={t} className="chip !mr-0">
										<input
											type="radio"
											name="mcp-transport"
											checked={form.transport === t}
											onChange={() => setForm({ ...form, transport: t })}
										/>
										{t === 'http' ? 'Remoto (HTTP)' : 'Local (comando)'}
									</label>
								))}
							</div>
						</Field>
						{form.transport === 'http' ? (
							<>
								<Field label="URL">
									<Input
										value={form.url}
										onChange={(e) => setForm({ ...form, url: e.target.value })}
										placeholder="https://mcp.linear.app/mcp"
										spellCheck={false}
									/>
								</Field>
								<Field label="OAuth" hint="O un token, no ambos">
									<label className="chip">
										<input
											type="checkbox"
											checked={form.oauth}
											onChange={(e) => setForm({ ...form, oauth: e.target.checked })}
										/>
										Cada agente inicia sesión en su navegador
									</label>
								</Field>
								<Field label="Encabezados" hint="p. ej. Authorization">
									<PairsEditor
										label="encabezado"
										pairs={form.headers}
										onChange={(headers) => setForm({ ...form, headers })}
										namePlaceholder="Authorization"
									/>
								</Field>
							</>
						) : (
							<>
								<Field label="Comando" hint="Sin ruta: npx, uvx…">
									<Input
										value={form.command}
										onChange={(e) => setForm({ ...form, command: e.target.value })}
										placeholder="npx"
										spellCheck={false}
									/>
								</Field>
								<Field label="Argumentos" hint="Separados por espacios">
									<Input
										value={form.args}
										onChange={(e) => setForm({ ...form, args: e.target.value })}
										placeholder="-y @linear/mcp-server"
										spellCheck={false}
									/>
								</Field>
								<Field label="Variables">
									<PairsEditor
										label="variable"
										pairs={form.env}
										onChange={(env) => setForm({ ...form, env })}
										namePlaceholder="LINEAR_API_KEY"
									/>
								</Field>
								<Field label="Dominios" hint="A los que llama con sus secretos">
									<Input
										value={form.domains}
										onChange={(e) => setForm({ ...form, domains: e.target.value })}
										placeholder="api.linear.app"
										spellCheck={false}
									/>
								</Field>
								<Field label="Valor real" hint="Si no habla HTTP">
									<label className="chip">
										<input
											type="checkbox"
											checked={form.exposeReal}
											onChange={(e) => setForm({ ...form, exposeReal: e.target.checked })}
										/>
										<span className={form.exposeReal ? 'danger' : 'muted'}>
											Entregar los valores reales (el agente los lee)
										</span>
									</label>
								</Field>
							</>
						)}
					</div>
					{access.error && (
						<p role="alert" className="error">
							{access.error}
						</p>
					)}
					<FormActions
						submitLabel={editing ? 'Guardar cambios' : 'Guardar servidor'}
						state={saveState}
						disabled={busy || !form.name.trim()}
						onCancel={() => setOpen(false)}
					/>
				</form>
			</FormDialog>
		</section>
	);
}
