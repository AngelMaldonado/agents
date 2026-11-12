// Modo objetivo (Angel 10-nov-2026): its owner's switch for the agent to work each trabajo until its objective is
// met. On, the platform keeps its trabajos going after each turn while nothing is waited for, stalls them (and
// tells its owner) when they do not advance, caps each with a budget, and an independent auditor checks its
// job_done. Turned on here, with /goal in a chat, or by approving it in the designer's interview or Automejora.
import { Target } from 'lucide-react';
import { cn } from '@/lib/utils';

export const GOAL_MODE_EXPLAIN =
	'Trabaja cada trabajo hasta cumplir su objetivo: después de cada turno la plataforma lo hace seguir mientras no espere nada (una respuesta, un encargo, una hora), lo detiene y te avisa si no avanza, le pone un presupuesto por trabajo (costo y turnos sin ti) y un auditor independiente revisa que de verdad terminó. Las decisiones reversibles las toma solo; lo que su contrato te reserva te lo pregunta. También se enciende con /goal en un chat.';

/** In the designer's proposal: whether it turns it on, off, or keeps it. */
export function GoalModeNote({ proposed, current }: { proposed: boolean | null | undefined; current?: boolean }) {
	const value = proposed ?? current ?? false;
	return (
		<div className={cn('goal-mode-note', value && 'is-on')}>
			<Target aria-hidden="true" />
			<div className="min-w-0">
				<p className="text-sm font-medium">
					Modo objetivo: {value ? 'encendido' : 'apagado'}
					<span className="ml-1 text-xs font-normal text-muted-foreground">
						{proposed === null || proposed === undefined
							? '(se conserva)'
							: proposed === current
								? '(sin cambio)'
								: '(propuesto)'}
					</span>
				</p>
				<p className="text-xs text-muted-foreground">{GOAL_MODE_EXPLAIN}</p>
			</div>
		</div>
	);
}
