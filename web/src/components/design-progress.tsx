// What the designer is doing while it answers (#26): its phase, the searches it runs and the summary of
// its reasoning, as the server streams them; and, once answered, that reasoning folded in the reply.
import { useEffect, useState } from 'react';
import type { ReasoningMessagePartComponent } from '@assistant-ui/react';
import { Brain, Check, ChevronRight, LoaderCircle, Search } from 'lucide-react';
import type { DesignProgress } from '@/api';

const phases: Record<DesignProgress['phase'], string> = {
	reading: 'Leyendo tu mensaje y el contexto',
	thinking: 'Pensando',
	searching: 'Buscando herramientas',
	questions: 'Preparando las preguntas',
	writing: 'Escribiendo la respuesta',
	contract: 'Redactando el contrato y el harness',
};
const registries: Record<string, string> = { buscar_mcp: 'MCP', buscar_cli: 'npm', buscar_skills: 'skills.sh' };

/** Live: the phase (shimmering), seconds so far, searches and the last lines of its reasoning. */
export function DesignerProgress({ progress, fallback }: { progress?: DesignProgress | null; fallback: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	const seconds = progress ? Math.max(0, Math.round((now - progress.started) / 1000)) : null;
	// The last paragraph of the summary: what it is thinking about right now.
	const thought = progress?.reasoning
		.trim()
		.split(/\n{2,}/)
		.at(-1)
		?.replace(/\*\*/g, '');
	return (
		<div role="status" className="designer-progress">
			<p className="flex items-center gap-2">
				<LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
				<span className="shimmer font-medium">{progress ? phases[progress.phase] : fallback}…</span>
				{seconds !== null && <span className="tnum text-2xs text-muted-foreground">{seconds} s</span>}
			</p>
			{!!progress?.searches.length && (
				<ul className="mt-2 grid gap-1 pl-6 text-2xs text-muted-foreground">
					{progress.searches.map((s, i) => (
						<li key={i} className="flex items-center gap-1.5">
							{s.done ? (
								<Check className="size-3 shrink-0 text-success" aria-hidden="true" />
							) : (
								<Search className="size-3 shrink-0" aria-hidden="true" />
							)}
							«{s.query}» en {registries[s.tool] ?? s.tool}
							{s.done && (
								<span>· {s.error ? 'no respondió' : `${s.results} resultado${s.results === 1 ? '' : 's'}`}</span>
							)}
						</li>
					))}
				</ul>
			)}
			{thought && (
				<p className="designer-progress-thought" aria-live="off">
					<Brain className="size-3 shrink-0" aria-hidden="true" />
					<span>{thought}</span>
				</p>
			)}
		</div>
	);
}

/** What the designer weighed for a reply (its «pensamiento», or the provider's reasoning summary when
 * it sends one), as an assistant-ui reasoning part, folded. */
export const ReasoningPart: ReasoningMessagePartComponent = ({ text }) =>
	text.trim() ? (
		<details className="designer-reasoning">
			<summary>
				<ChevronRight className="size-3.5 shrink-0 transition-transform" aria-hidden="true" />
				Qué consideró
			</summary>
			<p className="whitespace-pre-wrap">{text.replace(/\*\*/g, '')}</p>
		</details>
	) : null;
