// The only login: a name. Coming back from another browser takes an admin's one-time link.
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { AuthShell as EntryFrame } from '@/components/auth-shell';
import { api } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Entry({ onIn }: { onIn: () => void }) {
	const [name, setName] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError('');
		try {
			await api('/join', { body: { name } });
			onIn();
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<EntryFrame
			title="Tu espacio de trabajo"
			description="Agentes con su propia computadora. Dales una tarea y sigue su trabajo en vivo."
		>
			<form onSubmit={submit} className="entry-form pt-3">
				<div className="form gap-2">
					<Label htmlFor="entry-name">Tu nombre</Label>
					<Input
						id="entry-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Nombre y apellido"
						autoComplete="name"
						autoFocus
						maxLength={40}
						required
					/>
				</div>
				{error && (
					<p role="alert" className="error text-sm">
						{error}
					</p>
				)}
				<Button disabled={busy || !name.trim()}>
					{busy ? 'Entrando…' : 'Entrar'}
					<ArrowRight aria-hidden="true" />
				</Button>
				<p className="text-xs leading-relaxed text-muted-foreground">
					¿Ya usaste Agents en otro navegador? Pide a un admin un enlace de acceso.
				</p>
			</form>
		</EntryFrame>
	);
}

export function Invite({ code, onIn }: { code: string; onIn: () => void }) {
	const [who, setWho] = useState<{ id: number; name: string } | null | undefined>(undefined);
	const [error, setError] = useState('');
	useEffect(() => {
		api(`/invite/${code}`)
			.then((r) => setWho(r.person))
			.catch(() => setWho(null));
	}, [code]);
	if (who === undefined)
		return <EntryFrame title="Revisando el enlace…" description="Comprobando tu acceso a Agents." />;
	if (!who)
		return <EntryFrame title="Enlace vencido" description="Pídele a un admin un enlace nuevo para este navegador." />;
	return (
		<EntryFrame
			title={`Hola, ${who.name}`}
			description="Este enlace te permite entrar en este navegador. Sirve una sola vez."
		>
			<Button
				className="mt-3 w-full"
				onClick={async () => {
					try {
						await api(`/invite/${code}`, { method: 'POST' });
						location.hash = '';
						onIn();
					} catch (err) {
						setError((err as Error).message);
					}
				}}
			>
				Entrar como {who.name}
				<ArrowRight aria-hidden="true" />
			</Button>
			{error && (
				<p role="alert" className="error mt-3">
					{error}
				</p>
			)}
		</EntryFrame>
	);
}
