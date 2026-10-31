import type { ReactNode } from 'react';
import { ArrowLeft, BrainCircuit, BriefcaseBusiness, Clock3 } from 'lucide-react';
import type { Agent, PublicSettings, Task } from '@/api';
import { Character, STATE_LABEL } from '@/Character';
import { stateOf } from '@/Gallery';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function AgentHeader({
	agent,
	settings,
	mine,
	onBack,
	backLabel = 'Volver a agentes',
	work,
	children,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
	onBack: () => void;
	backLabel?: string;
	work?: { task: Task; historical: boolean; elapsed: number };
	children?: ReactNode;
}) {
	const state = stateOf(agent);
	return (
		<header className="agent-head">
			<div className="agent-heading">
				<Button variant="ghost" size="icon" onClick={onBack} aria-label={backLabel}>
					<ArrowLeft />
				</Button>
				<Character seed={agent.seed} state={state} size={48} />
				<div className="agent-id">
					<div className="agent-name-line">
						<h1 title={agent.name}>{agent.name}</h1>
						<Badge variant="outline" className={`pill s-${state}`}>
							{agent.task?.status === 'queued' ? 'En cola' : STATE_LABEL[state]}
						</Badge>
					</div>
					<div
						className="agent-header-meta muted small"
						aria-label={work ? 'Información del trabajo' : 'Modelo del agente'}
					>
						<span title={work ? 'Modelo del trabajo' : 'Modelo del agente'}>
							{settings.models.find((model) => model.id === (work?.task.model ?? agent.model))?.label ??
								work?.task.model ??
								agent.model}
							{!mine && ` · de ${agent.owner}`}
						</span>
						{work && (
							<>
								<span>
									{work.historical ? 'Snapshot histórico' : 'Trabajo'} #{work.task.id}
								</span>
								<span className="inline-flex items-center gap-1 tabular-nums" aria-label="Tiempo del trabajo">
									<Clock3 className="size-3" aria-hidden="true" />
									{Math.floor(work.elapsed / 60)}:{String(work.elapsed % 60).padStart(2, '0')}
								</span>
								<span className="tabular-nums">US${work.task.cost.toFixed(3)}</span>
								<span className="tabular-nums">{(work.task.tokens / 1000).toFixed(1)}k tokens</span>
							</>
						)}
					</div>
				</div>
			</div>
			{children && (
				<div className="agent-actions" aria-label="Acciones del agente">
					{children}
				</div>
			)}
		</header>
	);
}

export function TrabajoLink({ agentId, active = false }: { agentId: number; active?: boolean }) {
	return (
		<Button asChild variant="outline" size="sm" className="work-action">
			<a
				href={`#/agent/${agentId}`}
				aria-label="Abrir Trabajo"
				aria-current={active ? 'page' : undefined}
				title="Trabajo"
			>
				<BriefcaseBusiness aria-hidden="true" />
				<span className="agent-action-label">Trabajo</span>
			</a>
		</Button>
	);
}

export function AutomejoraLink({
	agentId,
	active = false,
	designId,
}: {
	agentId: number;
	active?: boolean;
	designId?: string;
}) {
	return (
		<Button asChild variant="outline" size="sm" className="automejora-action">
			<a
				href={`#/agent/${agentId}/improve${designId ? `/${designId}` : ''}`}
				aria-label="Abrir Automejora"
				aria-current={active ? 'page' : undefined}
				title="Automejora"
			>
				<BrainCircuit aria-hidden="true" />
				<span className="agent-action-label">Automejora</span>
			</a>
		</Button>
	);
}
