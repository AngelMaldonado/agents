// Avanzado → Estilo (Angel 13-nov-2026): how the agent sounds (shared/souls.ts). Its presets as illustrated tiles
// (Hermes Agent's, in Spanish, with Cuby's own «Cuby YOLO» first and by default), how the chosen one sounds, and
// its owner's own text instead («Personalizar»). It applies from the agent's next turn.
import { useState, type CSSProperties } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { api, type Agent } from '@/api';
import { DEFAULT_STYLE, SOUL_CHARS, STYLES, soulOf, styleOf } from '../../../shared/souls';
import { CubyBot } from '@/components/cuby-bot';
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
import { cn } from '@/lib/utils';

/** Each tile's hue (its illustration's background). */
const HUE: Record<string, number> = {
	'cuby-yolo': 25,
	helpful: 150,
	technical: 220,
	creative: 300,
	teacher: 45,
	kawaii: 340,
	catgirl: 280,
	pirate: 15,
	shakespeare: 265,
	surfer: 195,
	noir: 250,
	uwu: 320,
	philosopher: 85,
	hype: 5,
};

export function AgentStyle({ agent, mine, onChanged }: { agent: Agent; mine: boolean; onChanged: () => void }) {
	const [style, setStyle] = useState(agent.style ?? DEFAULT_STYLE);
	const [soul, setSoul] = useState(agent.soul ?? null);
	const [editing, setEditing] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const chosen = styleOf(style);
	const save = async (next: { style: string; soul: string | null }) => {
		setBusy(true);
		setError('');
		try {
			const r = await api<{ style: string | null; soul: string | null }>(`/agents/${agent.id}/soul`, {
				method: 'PUT',
				body: next,
			});
			setStyle(r.style ?? DEFAULT_STYLE);
			setSoul(r.soul);
			onChanged();
			return true;
		} catch (e) {
			setError((e as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<h3 className="brain-heading">Estilo</h3>
			<p className="brain-hint">
				Cómo habla, con su dueño y con cualquiera. Va primero en su prompt; aplica desde su siguiente turno.
			</p>
			<div className="style-grid" role="radiogroup" aria-label="Estilo">
				{STYLES.map((s) => (
					<button
						key={s.key}
						type="button"
						role="radio"
						aria-checked={!soul && s.key === style}
						disabled={!mine || busy}
						className={cn('style-tile', s.key === style && (soul ? 'is-base' : 'is-on'))}
						style={{ '--tone': HUE[s.key] ?? 220 } as CSSProperties}
						title={s.sample}
						onClick={() => void save({ style: s.key, soul: null })}
					>
						<span className="style-art" aria-hidden="true">
							{s.key === 'cuby-yolo' ? <CubyBot size={34} /> : <span className="style-emoji">{s.emoji}</span>}
							<span className="style-kaomoji">{s.kaomoji}</span>
						</span>
						<span className="style-name">{s.name}</span>
						<span className="style-desc">{s.description}</span>
					</button>
				))}
			</div>
			<div className="style-sample">
				<span className="style-sample-label">{soul ? 'Estilo propio' : `Así suena ${chosen.name}`}</span>
				<p className="style-bubble">{soul ? soul.split('\n')[0] : chosen.sample}</p>
				{mine && (
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(soulOf({ style, soul }))}>
							<Pencil aria-hidden="true" />
							Personalizar
						</Button>
						{soul && (
							<Button variant="ghost" size="sm" disabled={busy} onClick={() => void save({ style, soul: null })}>
								<RotateCcw aria-hidden="true" />
								Volver a {chosen.name}
							</Button>
						)}
					</div>
				)}
			</div>
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Su estilo</DialogTitle>
						<DialogDescription>
							Quién es y cómo habla: tono, qué evita y, mejor aún, ejemplos de cómo suena. Lo que hace va en su
							contrato.
						</DialogDescription>
					</DialogHeader>
					<Textarea
						aria-label="Su estilo"
						value={editing ?? ''}
						maxLength={SOUL_CHARS}
						rows={12}
						className="font-mono text-sm"
						onChange={(e) => setEditing(e.target.value)}
					/>
					<p className="text-2xs text-muted-foreground">
						{(editing ?? '').length} de {SOUL_CHARS} caracteres
					</p>
					<DialogFooter>
						<Button variant="outline" onClick={() => setEditing(null)}>
							Cancelar
						</Button>
						<Button
							disabled={busy || !(editing ?? '').trim()}
							onClick={async () => {
								const text = (editing ?? '').trim();
								// Unchanged from its style's own text: it stays on the style, not a copy of it.
								if (await save({ style, soul: text === chosen.text ? null : text })) setEditing(null);
							}}
						>
							Guardar
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
