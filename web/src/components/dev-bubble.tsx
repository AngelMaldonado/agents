// Development only: a bubble with what helps see the UI move. Today: the trabajo cards' animations
// (lib/card-preview), played on the first card or on all, without touching data.
import { FlaskConical, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { active, fill, playCycle, resetPreview, setPreview, usePreview } from '@/lib/card-preview';
import { cn } from '@/lib/utils';

export function DevBubble() {
	const p = usePreview();
	if (!import.meta.env.DEV) return null;
	const toggle = (label: string, on: boolean, change: (on: boolean) => void) => (
		<label className="dev-bubble-row">
			<span>{label}</span>
			<Switch checked={on} disabled={p.playing} onCheckedChange={change} aria-label={label} />
		</label>
	);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn('dev-bubble', active(p) && 'is-on')}
					aria-label="Desarrollo: animaciones de las tarjetas"
					title="Desarrollo"
				>
					<FlaskConical aria-hidden="true" />
				</button>
			</PopoverTrigger>
			<PopoverContent side="top" align="end" className="w-72 text-sm">
				<p className="font-medium">Animaciones de tarjetas</p>
				<p className="mt-0.5 text-2xs text-muted-foreground">Sólo en desarrollo; no cambia datos.</p>
				<div className="mt-3 grid gap-2">
					{toggle('Trabajando', p.live, (on) => setPreview({ live: on }))}
					{toggle('Evaluando', p.evaluating, (on) => setPreview({ evaluating: on, scored: false }))}
					{toggle('Aprendió algo', p.learned, (on) => setPreview({ learned: on }))}
					{toggle('Llenar tareas', p.step !== null, (on) => (on ? fill() : setPreview({ step: null })))}
					{toggle('En todas las tarjetas', p.all, (on) => setPreview({ all: on }))}
				</div>
				<div className="mt-3 flex gap-2">
					<Button size="sm" className="flex-1" disabled={p.playing} onClick={playCycle}>
						<Play aria-hidden="true" />
						Reproducir ciclo
					</Button>
					<Button size="sm" variant="outline" onClick={resetPreview}>
						<RotateCcw aria-hidden="true" />
						Restablecer
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
