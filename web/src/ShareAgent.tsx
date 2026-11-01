// The owner shares the agent: those people may run tasks with it (chat, give work, answer it). They
// cannot improve or configure it, nor take control of its browser; its runs use the owner's account.
// A gallery of people: clicking a tile shares it at once, clicking it again stops sharing it.
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api, type Agent, type Person } from './api';
import { SectionHead } from '@/components/access-ui';
import { cn } from '@/lib/utils';

type Someone = Pick<Person, 'id' | 'name' | 'avatar_seed'>;

export function ShareAgent({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
	const [people, setPeople] = useState<Someone[] | null>(null);
	const [chosen, setChosen] = useState<number[]>(agent.shares ?? []);
	const [pending, setPending] = useState<number | null>(null),
		[error, setError] = useState('');
	useEffect(() => {
		api<{ people: Someone[] }>('/people')
			.then((r) => setPeople(r.people.filter((p) => p.id !== agent.person_id)))
			.catch((e) => setError((e as Error).message));
	}, [agent.person_id]);
	const toggle = async (id: number) => {
		if (pending !== null) return;
		const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
		setPending(id);
		setError('');
		setChosen(next);
		try {
			setChosen(
				(await api<{ shares: number[] }>(`/agents/${agent.id}/shares`, { method: 'PUT', body: { people: next } }))
					.shares,
			);
			onChanged();
		} catch (e) {
			setChosen(chosen);
			setError((e as Error).message);
		} finally {
			setPending(null);
		}
	};
	return (
		<section className="panel grid min-w-0 gap-3" aria-label="Compartir">
			<SectionHead
				title="Compartir"
				security="Quienes elijas pueden darle tareas, conversar con él y responderle cuando se atore, en las mismas conversaciones. No pueden mejorarlo, configurarlo ni tomar el control de su navegador. Sus tareas usan tu cuenta GPT y tu cuota, y el agente usa sus sesiones, credenciales y compras autorizadas como siempre."
			/>
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
				<div className="harness-tiles" role="group" aria-label="Personas con quienes compartirlo">
					{people.map((p) => {
						const on = chosen.includes(p.id);
						return (
							<button
								key={p.id}
								type="button"
								role="checkbox"
								aria-checked={on}
								aria-busy={pending === p.id}
								disabled={pending !== null && pending !== p.id}
								className={cn('harness-tile share-tile', on && 'share-tile-on')}
								onClick={() => void toggle(p.id)}
							>
								<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium">
									{p.name.slice(0, 2).toUpperCase()}
								</span>
								<span className="min-w-0 flex-1 truncate">{p.name}</span>
								<span className="share-check" aria-hidden="true">
									{on && <Check className="size-3" />}
								</span>
							</button>
						);
					})}
				</div>
			)}
		</section>
	);
}
