import { useEffect, useState } from 'react';
import { api, type Agent, type AgentTool, type PublicSettings, type Harness } from './api';
import { ContractMarkdown, ToolsPanel } from '@/components/design-content';
import { Button } from '@/components/ui/button';
import { HarnessPanel } from '@/components/harness-content';

type Configuration = {
	agent: Agent;
	tools: AgentTool[];
	credentialNames: string[];
	effectivePrompt: string;
	draftId: string | null;
	setupDesignId: string | null;
	harness?: Harness;
	revisions?: { revision: number; name: string; model: string; created_at: number }[];
};
export function useAgentConfiguration(agent: Agent) {
	const [data, setData] = useState<Configuration | null>(null);
	const [error, setError] = useState('');
	const [reload, setReload] = useState(0);
	useEffect(() => {
		let alive = true;
		api<Configuration>(`/agents/${agent.id}/configuration`)
			.then((r) => {
				if (alive) {
					setData(r);
					setError('');
				}
			})
			.catch((err) => {
				if (alive) setError(err.message);
			});
		return () => {
			alive = false;
		};
	}, [agent.id, agent.config_revision, reload]);
	return { data, error, retry: () => setReload((n) => n + 1) };
}

export function AgentConfiguration({
	agent,
	settings,
	mine,
	onRestore,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
	onRestore?: () => void;
}) {
	const { data, error, retry } = useAgentConfiguration(agent);
	const [restoring, setRestoring] = useState<number | null>(null);
	const [restoreError, setRestoreError] = useState('');
	const [restored, setRestored] = useState<string | null>(null);
	const restore = async (revision: number) => {
		if (!mine || restoring !== null) return;
		const route = location.hash;
		setRestoring(revision);
		setRestoreError('');
		try {
			const r = await api<{ design: { id: string } }>('/designs', {
				body: { agentId: agent.id, model: agent.model, revision },
			});
			setRestored(r.design.id);
			if (location.hash === route) {
				location.hash = `/agent/${agent.id}/improve/${r.design.id}`;
				onRestore?.();
			}
		} catch (err) {
			setRestoreError((err as Error).message);
		} finally {
			setRestoring(null);
		}
	};
	if (error)
		return (
			<p role="alert" className="error">
				{error}{' '}
				<Button variant="outline" size="sm" onClick={retry}>
					Reintentar
				</Button>
			</p>
		);
	if (!data)
		return (
			<p role="status" className="muted">
				Cargando configuración…
			</p>
		);
	const current = { ...agent, ...data.agent };
	return (
		<div className="grid min-w-0 gap-6">
			<section className="grid min-w-0 gap-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h2 className="text-base font-semibold">Herramientas y entorno</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							Modelo: {settings.models.find((m) => m.id === current.model)?.label ?? current.model} · revisión{' '}
							{current.config_revision}
						</p>
					</div>
					{mine && data.setupDesignId && (
						<Button asChild variant="outline" size="sm">
							<a href={`#/new/${data.setupDesignId}`}>Ver inicialización</a>
						</Button>
					)}
				</div>
				<ToolsPanel tools={data.tools} />
				<p className="break-words text-xs text-muted-foreground">
					Accesos concedidos: {data.credentialNames.length ? data.credentialNames.join(', ') : 'ninguno'}. Se
					administran en Ajustes; el harness selecciona capacidades publicadas, pero no concede accesos ni instala
					paquetes externos.
				</p>
			</section>
			{data.harness && (
				<section className="min-w-0 border-t pt-5">
					<h2 className="mb-3">Harness vigente</h2>
					<HarnessPanel value={data.harness} />
				</section>
			)}
			{!!data.revisions?.length && (
				<section className="min-w-0 border-t pt-5">
					<h2 className="mb-3">Revisiones de la definición</h2>
					<p className="mb-3 text-xs text-muted-foreground">
						Restaurar prepara un borrador: debes probarlo y aprobarlo. No deshace archivos ni efectos externos ni
						reinicia la conversación.
					</p>
					<ul className="grid gap-3 text-xs">
						{data.revisions.map((r) => (
							<li key={r.revision} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
								<span className="min-w-0 break-words">
									Revisión {r.revision} · {r.name} · {r.model}
									{r.revision === current.config_revision ? ' · Vigente' : ''}
								</span>
								{mine && r.revision !== current.config_revision && (
									<Button
										type="button"
										variant="outline"
										size="xs"
										disabled={restoring !== null}
										onClick={() => void restore(r.revision)}
										aria-label={`Preparar restauración revisión ${r.revision}`}
									>
										{restoring === r.revision ? 'Preparando…' : 'Restaurar'}
									</Button>
								)}
							</li>
						))}
					</ul>
					{restoreError && (
						<p role="alert" className="error mt-3">
							{restoreError}
						</p>
					)}
					{restored && (
						<a className="mt-3 block text-xs text-primary underline" href={`#/agent/${agent.id}/improve/${restored}`}>
							Abrir borrador de restauración
						</a>
					)}
				</section>
			)}
			<section className="min-w-0">
				<h2 className="mb-3">Contrato vigente</h2>
				<ContractMarkdown text={current.role || 'Sin rol personalizado.'} />
				<div className="mt-6 min-w-0 border-t pt-5">
					<h2 className="mb-3">System prompt completo</h2>
					<ContractMarkdown text={data.effectivePrompt} />
				</div>
				{!mine && (
					<p className="mt-4 text-xs text-muted-foreground">
						Vista de administración. Sólo el dueño puede modificar el contrato, conversar y aprobar mejoras.
					</p>
				)}
			</section>
		</div>
	);
}
