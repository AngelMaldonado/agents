// Behind the shared PIN: global limits, the model catalog, the sandbox image, and people.
import { useEffect, useState } from 'react';
import { api, ago, type Person } from './api';
import { UsesTable } from './Settings';
import { Button } from '@/components/ui/button';
import { DeleteButton, IconButton, SaveButton, useSaving } from '@/components/actions';
import { CubyWhatsAppAdmin } from '@/components/cuby-whatsapp';
import { Link2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function Admin({ me, pinIsSet, onChanged }: { me: Person; pinIsSet: boolean; onChanged: () => void }) {
	if (!me.admin) return <Unlock pinIsSet={pinIsSet} onUnlocked={onChanged} />;
	return <Panel onChanged={onChanged} />;
}

function Unlock({ pinIsSet, onUnlocked }: { pinIsSet: boolean; onUnlocked: () => void }) {
	const [pin, setPin] = useState('');
	const [error, setError] = useState('');
	if (!pinIsSet)
		return (
			<div className="page">
				<p className="muted">Todavía no hay PIN: falta poner AGENTS_ADMIN_PIN en el stack.</p>
			</div>
		);
	return (
		<div className="page narrow">
			<h1 className="mb-2">Administración</h1>
			<p className="muted mb-6">Escribe el PIN de admin. Dura 30 días en este navegador.</p>
			<form
				className="row"
				onSubmit={async (e) => {
					e.preventDefault();
					try {
						await api('/admin/unlock', { body: { pin } });
						onUnlocked();
					} catch (err) {
						setError((err as Error).message);
					}
				}}
			>
				<Input
					type="password"
					aria-label="PIN de administrador"
					inputMode="numeric"
					value={pin}
					onChange={(e) => setPin(e.target.value)}
					autoFocus
				/>
				<Button>Entrar</Button>
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
			<Input
				type="number"
				aria-label={`Cuota de la persona ${person.id}`}
				min={0}
				max={60}
				value={value}
				className="w-20"
				onChange={(e) => setValue(Number(e.target.value))}
				onBlur={save}
				onKeyDown={(e) => e.key === 'Enter' && save()}
			/>
			{error && <span className="error small"> {error}</span>}
		</>
	);
}

function Panel({ onChanged }: { onChanged: () => void }) {
	const [data, setData] = useState<any>(null);
	const [draft, setDraft] = useState<any>(null);
	const [models, setModels] = useState('');
	const [msg, setMsg] = useState('');
	const saving = useSaving();
	const [link, setLink] = useState('');
	const load = () =>
		api('/admin').then((r) => {
			setData(r);
			setDraft(r.settings);
			setModels(r.settings.models.map((m: any) => `${m.id} | ${m.label}`).join('\n'));
		});
	useEffect(() => {
		void load();
	}, []);
	if (!data)
		return (
			<div className="page">
				<p className="muted">Cargando…</p>
			</div>
		);
	const num = (k: string) => (
		<Input
			type="number"
			value={draft[k]}
			onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
			step={k === 'maxCostUsd' ? 0.5 : 1}
		/>
	);
	return (
		<div className="page">
			<div className="page-head">
				<div>
					<h1>Administración</h1>
					<p className="muted">Límites, modelos y acceso del equipo.</p>
				</div>
				<Button
					variant="outline"
					onClick={async () => {
						await api('/admin/lock', { method: 'POST' });
						onChanged();
					}}
				>
					Salir de admin
				</Button>
			</div>
			<section className="panel">
				<h2>Límites</h2>
				<div className="field-list">
					<label className="field">
						<span>Computadoras a la vez, todos juntos (1–60)</span>
						{num('maxConcurrent')}
					</label>
					<label className="field">
						<span>Minutos máximos por tarea</span>
						{num('maxMinutes')}
					</label>
					<label className="field">
						<span>Tope de costo por tarea (US$)</span>
						{num('maxCostUsd')}
					</label>
					<label className="field">
						<span>Minutos que espera un agente atascado</span>
						{num('blockedWaitMinutes')}
					</label>
					<label className="field">
						<span>
							Avisos por WhatsApp al día por persona{' '}
							<span className="muted small block font-normal">de un mismo agente; 0: sin tope</span>
						</span>
						{num('noticesPerDay')}
					</label>
					<label className="field">
						<span>
							Horario de silencio: desde la hora (0–23){' '}
							<span className="muted small block font-normal">
								avisos y encargos esperan; igual a «hasta»: sin horario de silencio
							</span>
						</span>
						{num('quietFrom')}
					</label>
					<label className="field">
						<span>Horario de silencio: hasta la hora (0–23)</span>
						{num('quietTo')}
					</label>
					<label className="field">
						<span>
							Imagen del sandbox{' '}
							<span className="muted small block font-normal">vacía o la de la release: sigue a cada release</span>
						</span>
						<Input value={draft.sandboxImage} onChange={(e) => setDraft({ ...draft, sandboxImage: e.target.value })} />
					</label>
				</div>
				<label className="field mt-3">
					<span>
						Catálogo de modelos{' '}
						<span className="muted small block font-normal">
							uno por línea: <code>proveedor/modelo | nombre</code>
						</span>
					</span>
					<Textarea rows={6} value={models} onChange={(e) => setModels(e.target.value)} className="mono" />
				</label>
				<div className="field-actions row wrap mt-4">
					<SaveButton
						state={saving.state}
						onClick={async () => {
							setMsg('');
							const list = models
								.split('\n')
								.map((l) => l.trim())
								.filter(Boolean)
								.map((l) => {
									const [id, label] = l.split('|').map((s) => s.trim());
									return { id, label: label || id };
								});
							try {
								await saving.run(async () => {
									await api('/admin/settings', { method: 'PUT', body: { ...draft, models: list } });
									await load();
									onChanged();
								});
							} catch (err) {
								setMsg((err as Error).message);
							}
						}}
					/>
					<span className="muted">{msg}</span>
				</div>
			</section>
			<CubyWhatsAppAdmin />
			<section className="panel">
				<h2>Personas</h2>
				<p className="muted">
					Quien vuelve desde otro navegador necesita un link de un solo uso (24 h). La cuota es cuántas tareas suyas
					corren a la vez; las tuyas con el PIN puesto pasan primero en la cola.
				</p>
				{link && (
					<div className="callout mb-4 break-all">
						<code>{link}</code>{' '}
						<Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(link)}>
							Copiar
						</Button>
					</div>
				)}
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Nombre</TableHead>
							<TableHead>Agentes</TableHead>
							<TableHead>Tareas</TableHead>
							<TableHead>Cuota</TableHead>
							<TableHead>Desde</TableHead>
							<TableHead>
								<span className="sr-only">Acciones</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.people.map((p: any) => (
							<TableRow key={p.id}>
								<TableCell className="font-medium">{p.name}</TableCell>
								<TableCell>{p.agents}</TableCell>
								<TableCell>{p.tasks}</TableCell>
								<TableCell>
									<Quota person={p} onSaved={(people) => setData({ ...data, people })} />
								</TableCell>
								<TableCell className="text-xs">{ago(p.created_at)}</TableCell>
								<TableCell>
									<div className="row">
										<IconButton
											icon={Link2}
											label="Crear enlace de acceso"

											onClick={async () => {
												const { code } = await api(`/admin/people/${p.id}/invite`, { method: 'POST' });
												setLink(`${location.origin}/#/invite/${code}`);
											}}
										/>
										<DeleteButton
											onClick={async () => {
												if (confirm(`¿Borrar a ${p.name} con sus agentes, tareas, keys y accesos?`)) {
													await api(`/admin/people/${p.id}`, { method: 'DELETE' });
													await load();
													onChanged();
												}
											}}
										/>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</section>
			<section className="panel">
				<h2>Uso de accesos (todos)</h2>
				<p className="muted">Los secretos nunca se muestran, tampoco aquí.</p>
				<UsesTable uses={data.uses} showPerson />
			</section>
		</div>
	);
}
