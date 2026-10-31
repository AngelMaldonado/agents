// The owner shares the agent: those people may run tasks with it (chat, give work, answer it). They
// cannot improve or configure it, nor take control of its browser; its runs use the owner's account.
import { useEffect, useState } from 'react';
import { api, type Agent, type Person } from './api';
import { Button } from '@/components/ui/button';

type Someone = Pick<Person, 'id' | 'name' | 'avatar_seed'>;

export function ShareAgent({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
	const [people, setPeople] = useState<Someone[] | null>(null);
	const [chosen, setChosen] = useState<number[]>(agent.shares ?? []);
	const [busy, setBusy] = useState(false),
		[error, setError] = useState(''),
		[saved, setSaved] = useState(false);
	useEffect(() => {
		api<{ people: Someone[] }>('/people')
			.then((r) => setPeople(r.people.filter((p) => p.id !== agent.person_id)))
			.catch((e) => setError((e as Error).message));
	}, [agent.person_id]);
	const dirty = JSON.stringify([...chosen].sort()) !== JSON.stringify([...(agent.shares ?? [])].sort());
	return (
		<section className="grid min-w-0 gap-3 border-t pt-6" aria-label="Compartir">
			<h2>Compartir</h2>
			<p className="muted">
				Quienes elijas pueden darle tareas, conversar con él y responderle cuando se atore, en las mismas
				conversaciones. No pueden mejorarlo, configurarlo ni tomar el control de su navegador. Sus tareas usan tu cuenta
				GPT y tu cuota, y el agente usa sus sesiones, credenciales y compras autorizadas como siempre.
			</p>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			{!people ? (
				<p className="muted">Cargando…</p>
			) : !people.length ? (
				<p className="muted small">No hay otras personas en Agents todavía.</p>
			) : (
				<div className="grid max-h-60 gap-1 overflow-y-auto" role="group" aria-label="Personas">
					{people.map((p) => (
						<label key={p.id} className="row gap-2 text-sm">
							<input
								type="checkbox"
								checked={chosen.includes(p.id)}
								onChange={(e) => {
									setSaved(false);
									setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((id) => id !== p.id)));
								}}
							/>
							{p.name}
						</label>
					))}
				</div>
			)}
			<div className="row gap-2">
				<Button
					size="sm"
					disabled={!dirty || busy}
					onClick={async () => {
						setBusy(true);
						setError('');
						try {
							const r = await api<{ shares: number[] }>(`/agents/${agent.id}/shares`, {
								method: 'PUT',
								body: { people: chosen },
							});
							setChosen(r.shares);
							setSaved(true);
							onChanged();
						} catch (e) {
							setError((e as Error).message);
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? 'Guardando…' : 'Guardar'}
				</Button>
				{saved && !dirty && (
					<span role="status" className="muted small">
						Guardado.
					</span>
				)}
			</div>
		</section>
	);
}
