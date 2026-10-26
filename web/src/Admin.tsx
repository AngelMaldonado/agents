// Behind the shared PIN: global limits, the model catalog, the sandbox image, and people.
import { useEffect, useState } from 'react';
import { api, ago, type Person } from './api';
import { UsesTable } from './Settings';

export function Admin({ me, pinIsSet, onChanged }: { me: Person; pinIsSet: boolean; onChanged: () => void }) {
	if (!me.admin) return <Unlock pinIsSet={pinIsSet} onUnlocked={onChanged} />;
	return <Panel onChanged={onChanged} />;
}

function Unlock({ pinIsSet, onUnlocked }: { pinIsSet: boolean; onUnlocked: () => void }) {
	const [pin, setPin] = useState('');
	const [error, setError] = useState('');
	if (!pinIsSet) return <div className="page"><p className="muted">Todavía no hay PIN: falta poner AGENTS_ADMIN_PIN en el stack.</p></div>;
	return (
		<div className="page narrow">
			<h1>Admin</h1>
			<p className="muted">Escribe el PIN de admin. Dura 30 días en este navegador.</p>
			<form className="row" onSubmit={async (e) => {
				e.preventDefault();
				try {
					await api('/admin/unlock', { body: { pin } });
					onUnlocked();
				} catch (err) {
					setError((err as Error).message);
				}
			}}>
				<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
				<button className="primary">Entrar</button>
			</form>
			{error && <p className="error">{error}</p>}
		</div>
	);
}

/** A person's simultaneous-task quota, saved when it changes. */
function Quota({ person, onSaved }: { person: { id: number; run_quota: number }; onSaved: (people: any[]) => void }) {
	const [value, setValue] = useState(person.run_quota);
	const [error, setError] = useState('');
	const save = async () => {
		if (value === person.run_quota) return;
		try {
			const { people } = await api(`/admin/people/${person.id}/quota`, { method: 'PUT', body: { quota: value } });
			setError('');
			onSaved(people);
		} catch (err) {
			setError((err as Error).message);
		}
	};
	return (
		<>
			<input type="number" min={0} max={60} value={value} style={{ width: '4.5em' }}
				onChange={(e) => setValue(Number(e.target.value))} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
			{error && <span className="error small"> {error}</span>}
		</>
	);
}

function Panel({ onChanged }: { onChanged: () => void }) {
	const [data, setData] = useState<any>(null);
	const [draft, setDraft] = useState<any>(null);
	const [models, setModels] = useState('');
	const [msg, setMsg] = useState('');
	const [link, setLink] = useState('');
	const load = () => api('/admin').then((r) => {
		setData(r);
		setDraft(r.settings);
		setModels(r.settings.models.map((m: any) => `${m.id} | ${m.label}`).join('\n'));
	});
	useEffect(() => {
		void load();
	}, []);
	if (!data) return <div className="page"><p className="muted">Cargando…</p></div>;
	const num = (k: string) => (
		<input type="number" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} step={k === 'maxCostUsd' ? 0.5 : 1} />
	);
	return (
		<div className="page">
			<div className="page-head">
				<h1>Admin</h1>
				<button className="ghost" onClick={async () => { await api('/admin/lock', { method: 'POST' }); onChanged(); }}>Salir de admin</button>
			</div>
			<section className="panel">
				<h2>Límites</h2>
				<div className="settings-grid">
					<label>Computadoras a la vez, todos juntos (1–60){num('maxConcurrent')}</label>
					<label>Minutos máximos por tarea{num('maxMinutes')}</label>
					<label>Tope de costo por tarea (US$){num('maxCostUsd')}</label>
					<label>Minutos que espera un agente atascado{num('blockedWaitMinutes')}</label>
					<label>Imagen del sandbox<input value={draft.sandboxImage} onChange={(e) => setDraft({ ...draft, sandboxImage: e.target.value })} /></label>
				</div>
				<label>Catálogo de modelos (uno por línea: <code>proveedor/modelo | nombre</code>)
					<textarea rows={6} value={models} onChange={(e) => setModels(e.target.value)} className="mono" />
				</label>
				<div className="row">
					<button className="primary" onClick={async () => {
						const list = models.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
							const [id, label] = l.split('|').map((s) => s.trim());
							return { id, label: label || id };
						});
						try {
							await api('/admin/settings', { method: 'PUT', body: { ...draft, models: list } });
							setMsg('Guardado.');
							await load();
							onChanged();
						} catch (err) {
							setMsg((err as Error).message);
						}
					}}>Guardar</button>
					<span className="muted">{msg}</span>
				</div>
			</section>
			<section className="panel">
				<h2>Personas</h2>
				<p className="muted">Quien vuelve desde otro navegador necesita un link de un solo uso (24 h). La cuota es cuántas tareas suyas corren a la vez; las tuyas con el PIN puesto pasan primero en la cola.</p>
				{link && <div className="callout"><code>{link}</code> <button className="ghost" onClick={() => navigator.clipboard.writeText(link)}>Copiar</button></div>}
				<table>
					<thead><tr><th>Nombre</th><th>Agentes</th><th>Tareas</th><th>Cuota</th><th>Desde</th><th /></tr></thead>
					<tbody>
						{data.people.map((p: any) => (
							<tr key={p.id}>
								<td>{p.name}</td><td>{p.agents}</td><td>{p.tasks}</td>
								<td><Quota person={p} onSaved={(people) => setData({ ...data, people })} /></td>
								<td className="small">{ago(p.created_at)}</td>
								<td className="row">
									<button className="ghost" onClick={async () => { const { code } = await api(`/admin/people/${p.id}/invite`, { method: 'POST' }); setLink(`${location.origin}/#/invite/${code}`); }}>Link</button>
									<button className="ghost danger" onClick={async () => { if (confirm(`¿Borrar a ${p.name} con sus agentes, tareas, keys y accesos?`)) { await api(`/admin/people/${p.id}`, { method: 'DELETE' }); await load(); onChanged(); } }}>Borrar</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<section className="panel">
				<h2>Uso de accesos (todos)</h2>
				<p className="muted">Los secretos nunca se muestran, tampoco aquí.</p>
				<UsesTable uses={data.uses} showPerson />
			</section>
		</div>
	);
}
