// Configuración → WhatsApp: the photo of my groups «Agentes <me>» (#18). The browser makes it a 640×640
// JPEG (centred crop), the format WhatsApp takes for a group; new groups get it, and on Agents' own
// numbers the open ones are updated too.
import { useEffect, useRef, useState } from 'react';
import { ImageUp } from 'lucide-react';
import { api } from '@/api';
import { InfoTip } from '@/WhatsApp';
import { SaveButton, useSaving } from '@/components/actions';
import { Button } from '@/components/ui/button';

type View = {
	available: boolean;
	photo: string | null;
	updatedAt: number | null;
	groups: number;
	updatesOpen: boolean;
};

/** A square JPEG from any image the browser can open, as a data URL. */
async function squareJpeg(file: File, size = 640) {
	const bitmap = await createImageBitmap(file);
	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#fff'; // a transparent PNG would turn black in a JPEG
	ctx.fillRect(0, 0, size, size);
	ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
	bitmap.close();
	return canvas.toDataURL('image/jpeg', 0.86);
}

export function WhatsAppGroupPhoto() {
	const [v, setV] = useState<View | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState('');
	const saving = useSaving();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		api<View>('/whatsapp/group-photo')
			.then(setV)
			.catch(() => {});
	}, []);
	if (!v?.available) return null;
	const shown = draft ?? v.photo;
	const act = async (method: 'PUT' | 'DELETE') => {
		setError('');
		try {
			await saving.run(async () => {
				setV(
					await api<View>('/whatsapp/group-photo', { method, body: method === 'PUT' ? { jpeg: draft } : undefined }),
				);
				setDraft(null);
			});
		} catch (err) {
			setError((err as Error).message);
		}
	};
	return (
		<section className="panel" aria-label="Foto de tus grupos de agentes">
			<h2 className="inline-flex items-center gap-2">
				Foto de tus grupos
				<InfoTip label="Dónde se ve esta foto">
					Es la foto de tus grupos «Agentes …»: el tuyo y el de cada persona con quien compartes agentes. La reciben los
					grupos que se creen desde ahora.{' '}
					{v.updatesOpen
						? 'Los que ya están abiertos se actualizan en un minuto.'
						: 'Los que ya existen se quedan con la suya: Cuby WhatsApp sólo pone la foto al crear un grupo.'}
				</InfoTip>
			</h2>
			<div className="row wrap items-center gap-4">
				<div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-full border bg-muted">
					{shown ? (
						<img src={shown} alt="Foto de tus grupos" className="size-full object-cover" />
					) : (
						<ImageUp className="size-7 text-muted-foreground" aria-hidden="true" />
					)}
				</div>
				<div className="grid gap-2">
					<input
						ref={input}
						type="file"
						accept="image/*"
						className="sr-only"
						aria-label="Elegir la foto de tus grupos"
						onChange={async (e) => {
							const file = e.target.files?.[0];
							e.target.value = '';
							if (!file) return;
							setError('');
							try {
								setDraft(await squareJpeg(file));
							} catch {
								setError('No pude abrir esa imagen. Prueba con un JPG o PNG.');
							}
						}}
					/>
					<div className="row wrap gap-2">
						<Button variant="outline" size="sm" onClick={() => input.current?.click()}>
							{v.photo || draft ? 'Cambiar foto' : 'Elegir foto'}
						</Button>
						{draft && (
							<>
								<SaveButton size="sm" state={saving.state} onClick={() => void act('PUT')} />
								<Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
									Cancelar
								</Button>
							</>
						)}
						{!draft && v.photo && (
							<Button variant="danger-ghost" size="sm" onClick={() => void act('DELETE')}>
								Quitar
							</Button>
						)}
					</div>
					<p className="muted small">
						Se recorta al centro en un cuadrado.{' '}
						{v.groups
							? `Tienes ${v.groups} grupo${v.groups === 1 ? '' : 's'} abierto${v.groups === 1 ? '' : 's'}.`
							: ''}
					</p>
				</div>
			</div>
			{error && (
				<p role="alert" className="error mt-2">
					{error}
				</p>
			)}
		</section>
	);
}
