// The person's accesses the designer suggested for the agent: one row each (name, kind, where it goes),
// why in a «?» tooltip, and «Conceder». In the initialization it is granted at once; in the contract
// panel of a new agent (which does not exist yet) it is granted when the proposal is approved.
import { useState } from 'react';
import { Check, CircleHelp, Clock, Globe, KeyRound, Plug } from 'lucide-react';
import type { AccessSuggestion } from '@/api';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const icons = { site: Globe, mcp: Plug, key: KeyRound };
const kinds = { site: 'Acceso a sitio', mcp: 'Servidor MCP', key: 'API key' };

export function AccessSuggestions({
	suggestions,
	onGrant,
	heading = false,
}: {
	suggestions: AccessSuggestion[];
	/** Without it they are only listed. */
	onGrant?: (kind: string, id: number) => Promise<void>;
	/** The initialization's own title and explanation (the contract panel has its own). */
	heading?: boolean;
}) {
	const [busy, setBusy] = useState<string | null>(null),
		[error, setError] = useState('');
	const grant = async (keys: string[], list: AccessSuggestion[]) => {
		if (!onGrant) return;
		setBusy(keys.length > 1 ? 'all' : keys[0]);
		setError('');
		try {
			for (const s of list) await onGrant(s.kind, s.id);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};
	const pending = suggestions.filter((s) => !s.granted && !s.accepted);
	return (
		<section aria-labelledby={heading ? 'access-suggestions-title' : undefined} className="grid min-w-0 gap-3">
			{heading && (
				<div>
					<h2 id="access-suggestions-title" className="text-sm font-semibold">
						Accesos sugeridos
					</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						Son tuyos y ya están guardados. Concédeselos sólo a este agente con un clic (después se administran en
						Configuración → Accesos).
					</p>
				</div>
			)}
			<ul className="grid min-w-0 gap-2">
				{suggestions.map((s) => {
					const Icon = icons[s.kind],
						key = `${s.kind}:${s.id}`;
					return (
						<li key={key} className="flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-xs">
							<Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
							<div className="min-w-0 flex-1">
								<p className="flex min-w-0 items-center gap-1.5">
									<span className="truncate font-medium">{s.name}</span>
									<span className="shrink-0 text-muted-foreground">· {kinds[s.kind]}</span>
									{s.reason && (
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
													aria-label={`Por qué ${s.name}: ${s.reason}`}
												>
													<CircleHelp className="size-3.5" aria-hidden="true" />
												</button>
											</TooltipTrigger>
											<TooltipContent side="top" className="max-w-xs">
												{s.reason}
											</TooltipContent>
										</Tooltip>
									)}
								</p>
								{s.detail && <p className="truncate font-mono text-2xs text-muted-foreground">{s.detail}</p>}
							</div>
							{s.granted ? (
								<span className="inline-flex shrink-0 items-center gap-1 text-success">
									<Check className="size-4" aria-hidden="true" />
									Concedido
								</span>
							) : s.accepted ? (
								<span
									className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
									title="Se concede a este agente cuando apruebes la propuesta."
								>
									<Clock className="size-4" aria-hidden="true" />
									Al inicializar
								</span>
							) : (
								onGrant && (
									<Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void grant([key], [s])}>
										{busy === key ? 'Concediendo…' : 'Conceder'}
									</Button>
								)
							)}
						</li>
					);
				})}
			</ul>
			{error && (
				<p role="alert" className="error text-xs">
					{error}
				</p>
			)}
			{onGrant && pending.length > 1 && (
				<Button
					size="sm"
					className="justify-self-start"
					disabled={busy !== null}
					onClick={() => void grant(['all'], pending)}
				>
					{busy === 'all' ? 'Concediendo…' : `Conceder los ${pending.length}`}
				</Button>
			)}
		</section>
	);
}
