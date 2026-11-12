import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormDialog } from '@/components/access-ui';
import { SaveButton, useSaving } from '@/components/actions';

export type ChatRef = { id: number; agent_id: number; title: string };

/** Renaming or deleting a chat (sidebar, the hub's Recientes): one dialog, over the page. */
export function ChatDialog<T extends ChatRef>({
	edit,
	onClose,
	onDone,
}: {
	edit: { chat: T; action: 'rename' | 'delete' } | null;
	onClose: () => void;
	onDone: (deleted: T | null) => void;
}) {
	const [title, setTitle] = useState('');
	const [busy, setBusy] = useState(false);
	const saving = useSaving();
	const [error, setError] = useState('');
	useEffect(() => {
		setTitle(edit?.chat.title ?? '');
		setError('');
	}, [edit]);
	const chat = edit?.chat;
	const path = chat && `/agents/${chat.agent_id}/conversations/${chat.id}`;
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError('');
		try {
			await fn();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<FormDialog
			open={!!edit}
			onOpenChange={(open) => !open && !busy && onClose()}
			title={edit?.action === 'delete' ? '¿Eliminar este chat?' : 'Renombrar chat'}
			description={
				edit?.action === 'delete'
					? `«${chat?.title}» desaparece de tus listas y de la búsqueda. Sus mensajes, turnos y archivos se conservan.`
					: undefined
			}
		>
			<form
				className="form"
				onSubmit={(e) => {
					e.preventDefault();
					if (!path) return;
					void run(async () => {
						if (edit?.action === 'delete') {
							await api(path, { method: 'DELETE' });
							onDone(chat!);
						} else {
							await saving.run(() => api(path, { method: 'PATCH', body: { title } }), { hold: true });
							onDone(null);
						}
					});
				}}
			>
				{edit?.action === 'rename' && (
					<label>
						Título
						<Input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							maxLength={80}
							autoFocus
							placeholder="Vacío: vuelve al título automático"
						/>
					</label>
				)}
				{error && (
					<p role="alert" className="error">
						{error}
					</p>
				)}
				<div className="flex flex-wrap justify-end gap-2 border-t pt-4">
					<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
						<X aria-hidden="true" />
						Cancelar
					</Button>
					{edit?.action === 'delete' ? (
						<Button type="submit" variant="destructive" disabled={busy}>
							<Trash2 aria-hidden="true" />
							Eliminar
						</Button>
					) : (
						<SaveButton type="submit" disabled={busy} state={saving.state} />
					)}
				</div>
			</form>
		</FormDialog>
	);
}
