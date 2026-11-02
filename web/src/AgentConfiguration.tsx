import { useEffect, useState } from 'react';
import { api, type Agent, type AgentTool, type PublicSettings, type Harness } from './api';
import { ToolsPanel } from '@/components/design-content';
import { Button } from '@/components/ui/button';

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

/** Configuración → General: what the agent can use. Its definition (prompts, skills, MCP, CLI,
 * revisions) is in Avanzado → Harness. */
export function AgentConfiguration({
	agent,
	settings,
	mine,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
}) {
	const { data, error, retry } = useAgentConfiguration(agent);
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
		<section className="panel grid min-w-0 gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-base font-semibold">Herramientas y entorno</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						{mine ? '' : `${settings.models.find((m) => m.id === current.model)?.label ?? current.model} · `}
						{mine ? 'Revisión' : 'revisión'} {current.config_revision}
					</p>
				</div>
				{mine && data.setupDesignId && (
					<Button asChild variant="outline" size="sm">
						<a href={`#/new/${data.setupDesignId}`}>Ver inicialización</a>
					</Button>
				)}
			</div>
			<ToolsPanel tools={data.tools} compact />
			<p className="break-words text-xs text-muted-foreground">
				Accesos concedidos: {data.credentialNames.length ? data.credentialNames.join(', ') : 'ninguno'}. Se administran
				en Ajustes; el harness selecciona capacidades publicadas, pero no concede accesos ni instala paquetes externos.
			</p>
			{!mine && (
				<p className="text-xs text-muted-foreground">
					Vista de administración. Sólo el dueño puede modificar el contrato, conversar y aprobar mejoras.
				</p>
			)}
		</section>
	);
}
