// `agents-mcp add` from the agent's computer (#27): the owner adds that MCP server to their Accesos,
// granted to this agent, or discards it. Nothing is registered before that click.
import { useState } from 'react';
import { Check, Plug } from 'lucide-react';
import { api, type TaskEvent } from '@/api';
import { Button } from '@/components/ui/button';

type McpRequest = { rid: string; name: string; url: string; description: string; status: string };

/** `agents-mcp add` from the computer: the owner adds it to their Accesos (granted to this agent) or not. */
export function McpRequests({ taskId, events, mine }: { taskId: number; events: TaskEvent[]; mine: boolean }) {
	const latest = new Map<string, McpRequest>();
	for (const e of events) if (e.kind === 'mcp_request') latest.set(e.data.rid, e.data as McpRequest);
	const [busy, setBusy] = useState<string | null>(null),
		[error, setError] = useState('');
	if (!latest.size) return null;
	const answer = async (rid: string, accept: boolean) => {
		setBusy(rid);
		setError('');
		try {
			await api(`/tasks/${taskId}/mcp-requests/${rid}`, { method: 'POST', body: { accept } });
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};
	return (
		<ul className="mb-3 grid gap-2" aria-label="Servidores MCP pedidos desde la computadora">
			{[...latest.values()].map((r) => (
				<li key={r.rid} className="flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-xs">
					<Plug className="size-4 shrink-0 text-primary" aria-hidden="true" />
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium">MCP {r.name}</p>
						<p className="truncate font-mono text-2xs text-muted-foreground">{r.url}</p>
					</div>
					{r.status === 'added' ? (
						<span className="inline-flex shrink-0 items-center gap-1 text-success">
							<Check className="size-4" aria-hidden="true" />
							En tus Accesos
						</span>
					) : r.status === 'discarded' ? (
						<span className="shrink-0 text-muted-foreground">Descartado</span>
					) : mine ? (
						<span className="flex shrink-0 gap-2">
							<Button size="sm" variant="outline" disabled={!!busy} onClick={() => void answer(r.rid, false)}>
								Descartar
							</Button>
							<Button size="sm" disabled={!!busy} onClick={() => void answer(r.rid, true)}>
								{busy === r.rid ? 'Agregando…' : 'Agregar y conceder'}
							</Button>
						</span>
					) : (
						<span className="shrink-0 text-muted-foreground">Esperando al dueño</span>
					)}
				</li>
			))}
			{error && (
				<li role="alert" className="error">
					{error}
				</li>
			)}
		</ul>
	);
}
