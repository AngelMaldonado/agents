// Aprender (Angel 12-nov-2026): its owner teaches the agent something from a trabajo, in their own words.
// It becomes one of its Aprendizajes, pinned (its owner said it), and the trabajo shows it.
import { useState, type FormEvent } from 'react';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

export function LearnDialog({
	agentId,
	job,
	onClose,
	onDone,
}: {
	agentId: number;
	/** The trabajo it learns from (id null: none in particular); null: closed. */
	job: { id: number | null; title: string | null } | null;
	onClose: () => void;
	onDone: () => void;
}) {
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const save = async (e: FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError('');
		try {
			await api(`/agents/${agentId}/lessons`, { body: { text, conversation: job?.id ?? undefined } });
			setText('');
			onDone();
		} catch (x) {
			setError((x as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={!!job} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={save} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>Aprender</DialogTitle>
						<DialogDescription>
							{job?.id
								? `Qué debe recordar de ${job.title ? `«${job.title}»` : 'este trabajo'} para los siguientes.`
								: 'Qué debe saber en todos sus trabajos.'}{' '}
							Queda fijado: entra en el playbook de cada trabajo.
						</DialogDescription>
					</DialogHeader>
					<Textarea
						aria-label="Lo que debe aprender"
						placeholder="Por ejemplo: Miguel da el visto bueno; no me pidas aprobación a mí."
						value={text}
						maxLength={300}
						rows={3}
						autoFocus
						onChange={(e) => setText(e.target.value)}
					/>
					{error && (
						<p role="alert" className="error">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancelar
						</Button>
						<Button type="submit" disabled={busy || !text.trim()}>
							Guardar
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
