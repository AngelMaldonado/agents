// Each person's own: provider keys (write-only) and site logins for their agents (write-only).
import { useEffect, useState } from 'react';
import { api, ago, type Agent, type Credential, type Person } from './api';

type KeyRow = { provider: 'anthropic' | 'openai'; last4: string; updated_at: number };

export function Settings({ me, agents }: { me: Person; agents: Agent[] }) {
	const mine = agents.filter((a) => a.person_id === me.id);
	return (
		<div className="page">
			<h1>Ajustes de {me.name}</h1>
			<Keys />
			<Vault agents={mine} />
		</div>
	);
}

function Keys() {
	const [keys, setKeys] = useState<KeyRow[]>([]);
	useEffect(() => {
		api('/keys').then((r) => setKeys(r.keys));
	}, []);
	return (
		<section className="panel">
			<h2>Tus API keys</h2>
			<p className="muted">Las tareas que lanzas consumen tu cuenta. Las keys se guardan cifradas y no se vuelven a mostrar, ni siquiera al admin; los agentes nunca las ven.</p>
			<KeyRowForm provider="anthropic" label="Anthropic (Claude)" hint="sk-ant-api03-… · Console de Anthropic o créditos API de tu plan" row={keys.find((k) => k.provider === 'anthropic')} onSaved={setKeys} />
			<KeyRowForm provider="openai" label="OpenAI (GPT)" hint="sk-proj-… · platform.openai.com" row={keys.find((k) => k.provider === 'openai')} onSaved={setKeys} />
			<p className="muted small">Claude sólo con API key: usar el login de una suscripción Claude Pro/Max a través de un proxy viola los términos de Anthropic.</p>
		</section>
	);
}

function KeyRowForm({ provider, label, hint, row, onSaved }: { provider: string; label: string; hint: string; row?: KeyRow; onSaved: (k: KeyRow[]) => void }) {
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
				<b>{label}</b>
				<div className="muted small">{row ? `Guardada · termina en …${row.last4} · ${ago(row.updated_at)}` : 'Sin key'}</div>
			</div>
			<input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hint} autoComplete="off" />
			<button className="primary" disabled={!value.trim()}>{row ? 'Reemplazar' : 'Guardar'}</button>
			{row && <button type="button" className="ghost" onClick={async () => onSaved((await api(`/keys/${provider}`, { method: 'DELETE' })).keys)}>Quitar</button>}
			{error && <p className="error">{error}</p>}
		</form>
	);
}

function Vault({ agents }: { agents: Agent[] }) {
	const [creds, setCreds] = useState<Credential[]>([]);
	const [uses, setUses] = useState<any[]>([]);
	const [form, setForm] = useState({ name: '', loginUrl: '', username: '', password: '' });
	const [error, setError] = useState('');
	const load = () => api('/vault').then((r) => { setCreds(r.credentials); setUses(r.uses); });
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
			<p className="muted">Usuario y contraseña de sitios donde tus agentes necesitan entrar. El agente sólo conoce el nombre: escribe <code>buyer-login nombre</code> y el navegador llena el formulario sin que el modelo vea el secreto. Sólo los agentes que marques pueden usar cada acceso, y sólo en su dominio.</p>
			<table className="vault">
				<thead><tr><th>Nombre</th><th>Sitio</th><th>Agentes con acceso</th><th /></tr></thead>
				<tbody>
					{creds.map((c) => (
						<tr key={c.id}>
							<td><code>{c.name}</code></td>
							<td className="small">{c.origin}</td>
							<td>
								{agents.map((a) => (
									<label key={a.id} className="chip">
										<input type="checkbox" checked={c.agents.includes(a.id)} onChange={() => toggle(c, a.id)} /> {a.name}
									</label>
								))}
								{!agents.length && <span className="muted small">Crea un agente primero</span>}
							</td>
							<td><button className="ghost" onClick={async () => confirm(`¿Borrar ${c.name}?`) && setCreds((await api(`/vault/${c.id}`, { method: 'DELETE' })).credentials)}>Borrar</button></td>
						</tr>
					))}
					{!creds.length && <tr><td colSpan={4} className="muted">Sin accesos guardados.</td></tr>}
				</tbody>
			</table>
			<form
				className="form inline"
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
				<h3>Agregar o reemplazar un acceso</h3>
				<div className="row wrap">
					<input placeholder="nombre (p. ej. steren)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
					<input placeholder="URL de la página de login" value={form.loginUrl} onChange={(e) => setForm({ ...form, loginUrl: e.target.value })} />
					<input placeholder="usuario" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
					<input placeholder="contraseña" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
					<button className="primary">Guardar</button>
				</div>
				{error && <p className="error">{error}</p>}
				<p className="muted small">Sin segundo factor por ahora: si un sitio lo pide, el agente se declara atascado y lo salta.</p>
			</form>
			<h3>Últimos usos</h3>
			<UsesTable uses={uses} />
		</section>
	);
}

export function UsesTable({ uses, showPerson }: { uses: any[]; showPerson?: boolean }) {
	return (
		<table className="uses">
			<tbody>
				{uses.map((u) => (
					<tr key={u.id}>
						<td className="small">{new Date(u.at).toLocaleString('es-MX')}</td>
						{showPerson && <td>{u.person}</td>}
						<td><code>{u.credential_name}</code></td>
						<td className="small">tarea #{u.task_id}</td>
						<td className={u.ok ? 'ok' : 'error'}>{u.ok ? 'entregada' : 'negada'}</td>
						<td className="small muted">{u.detail}</td>
					</tr>
				))}
				{!uses.length && <tr><td className="muted">Nadie ha usado un acceso.</td></tr>}
			</tbody>
		</table>
	);
}
