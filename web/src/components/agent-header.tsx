import type { ReactNode } from 'react';
import { ArrowLeft, BrainCircuit, UserPlus } from 'lucide-react';
import type { Agent, Person, PublicSettings } from '@/api';
import { Character, STATE_LABEL } from '@/Character';
import { stateOf } from '@/Gallery';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/actions';
import { PeopleStack } from '@/components/people-stack';
import { StatusIcon } from '@/components/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** The model's label as the admin named it, or its id. */
export const modelLabel = (settings: PublicSettings, model: string) =>
	settings.models.find((m) => m.id === model)?.label ?? model;

/**
 * The agent's header in its hub and in Automejora: who it is, what it is doing (an icon by the model),
 * who works with it, and its actions. The chat view puts a breadcrumb in the app bar instead.
 */
export function AgentHeader({
	agent,
	settings,
	mine,
	onBack,
	backLabel = 'Volver a agentes',
	people,
	onShare,
	children,
}: {
	agent: Agent;
	settings: PublicSettings;
	mine: boolean;
	onBack: () => void;
	backLabel?: string;
	people: Pick<Person, 'id' | 'name'>[];
	onShare?: () => void;
	children?: ReactNode;
}) {
	const state = stateOf(agent);
	const queued = agent.task?.status === 'queued';
	return (
		<header className="agent-head">
			<div className="agent-heading">
				<Button variant="ghost" size="icon" onClick={onBack} aria-label={backLabel} title={backLabel}>
					<ArrowLeft />
				</Button>
				<Character seed={agent.seed} state={state} size={48} />
				<div className="agent-id">
					<div className="agent-name-line">
						<h1 title={agent.name}>{agent.name}</h1>
					</div>
					<div className="agent-header-meta muted small" aria-label="Modelo y estado del agente">
						<span className="inline-flex min-w-0 items-center gap-1.5">
							<StatusIcon status={queued ? 'queued' : state} label={queued ? 'En cola' : STATE_LABEL[state]} />
							<span className="truncate">
								{modelLabel(settings, agent.model)}
								{!mine && ` · de ${agent.owner}`}
							</span>
						</span>
					</div>
				</div>
			</div>
			{/* The actions, and under them who works with it. */}
			<div className="agent-head-side">
				{children && (
					<div className="agent-actions" aria-label="Acciones del agente">
						{children}
					</div>
				)}
				<span className="inline-flex items-center gap-1">
					<PeopleStack people={people} />
					{onShare && <IconButton icon={UserPlus} label="Compartir" onClick={onShare} className="size-6" />}
				</span>
			</div>
		</header>
	);
}

/** Automejora: a button with its name in the hub's header, an icon in the chat view's bar. */
export function AutomejoraLink({
	agentId,
	active = false,
	designId,
	iconOnly = false,
}: {
	agentId: number;
	active?: boolean;
	designId?: string;
	iconOnly?: boolean;
}) {
	const link = (
		<Button
			asChild
			variant={iconOnly ? 'ghost' : 'outline'}
			size={iconOnly ? 'icon-sm' : 'sm'}
			className="automejora-action"
		>
			<a
				href={`#/agent/${agentId}/improve${designId ? `/${designId}` : ''}`}
				aria-label="Abrir Automejora"
				aria-current={active ? 'page' : undefined}
			>
				<BrainCircuit aria-hidden="true" />
				{!iconOnly && <span className="agent-action-label">Automejora</span>}
			</a>
		</Button>
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>{link}</TooltipTrigger>
			<TooltipContent side="bottom">Automejora</TooltipContent>
		</Tooltip>
	);
}
