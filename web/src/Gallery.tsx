import { ArrowUpRight, Bot, CircleArrowUp, LoaderCircle, Plus } from 'lucide-react';
import { ImportAgent } from '@/components/agent-bundle';
import { imageVersion } from '@/lib/image-version';
import { isLive, ago, type Agent, type Person, type PublicSettings } from './api';
import { Character, STATE_LABEL, type CharState } from './Character';
import { Browser } from './Browser';
import { useTick } from './live';
import { StatusIcon, type CardStatus } from '@/components/status-icon';
import { PeopleStack } from '@/components/people-stack';
import { Ticker } from '@/components/ticker';
import { crewOf, usePeople, type Someone } from '@/lib/use-people';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComputerUpdatesButton } from '@/components/computer-update-jobs';
import { useComputerUpdates } from '@/lib/computer-updates';
import { updatePending, UPDATE_LABEL } from '../../shared/computer-updates';

/** When it last worked: now (it is working), its last work's end, start or creation; or when it was made. */
const lastActivity = (a: Agent) =>
	isLive(a.task)
		? Number.MAX_SAFE_INTEGER
		: Math.max(
				a.task?.ended_at ?? 0,
				a.task?.started_at ?? 0,
				a.task?.created_at ?? 0,
				// never worked: after every agent that did, newest first
				(a.created_at ?? 0) - 1e13,
			);

export function stateOf(a: Agent): CharState {
	if (!a.task || a.task.status === 'queued') return 'idle';
	return a.task.state;
}

export function Gallery({
	agents,
	me,
	settings,
	onOpen,
}: {
	agents: Agent[];
	me: Person;
	settings: PublicSettings;
	onOpen: (id: number) => void;
	onChanged: () => void;
}) {
	useTick(5000);
	const people = usePeople();
	// The ones with recent activity first: working now, then by their last work; never-used last.
	const byActivity = [...agents].sort((x, y) => lastActivity(y) - lastActivity(x));
	const mine = byActivity.filter((a) => a.person_id === me.id);
	const shared = byActivity.filter((a) => a.person_id !== me.id && a.shares?.includes(me.id));
	const others = byActivity.filter((a) => a.person_id !== me.id && !a.shares?.includes(me.id));
	const running = agents.filter((a) => isLive(a.task) && a.task!.status !== 'queued').length;
	return (
		<div className="page">
			<div className="page-head">
				<div>
					<div className="flex items-center gap-3">
						<h1>Tus agentes</h1>
						<Badge variant="secondary">{mine.length}</Badge>
					</div>
					<p className="muted">
						{running} trabajando ahora · hasta {settings.maxConcurrent} a la vez
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<ComputerUpdatesButton />
					<ImportAgent />
					<Button asChild>
						<a href="#/new">
							<Plus aria-hidden="true" />
							Nuevo agente
						</a>
					</Button>
				</div>
			</div>
			{!mine.length && (
				<div className="empty">
					<Bot className="mx-auto mb-4 size-8 text-muted-foreground" aria-hidden="true" />
					<h2 className="text-foreground">Tu primer agente empieza con una conversación</h2>
					<p className="mx-auto mt-2 max-w-md">
						Cuéntale a la IA qué trabajo quieres delegar. Revisarás su contrato antes de crearlo y después podrás seguir
						su trabajo en vivo.
					</p>
				</div>
			)}
			<div className="agent-grid">
				{mine.map((a) => (
					<AgentCard key={a.id} agent={a} people={people} onOpen={onOpen} />
				))}
			</div>
			{shared.length > 0 && (
				<section aria-label="Compartidos contigo">
					<h2 className="section">
						Compartidos contigo <Badge variant="secondary">{shared.length}</Badge>
					</h2>
					<div className="agent-grid">
						{shared.map((a) => (
							<AgentCard key={a.id} agent={a} people={people} onOpen={onOpen} showOwner />
						))}
					</div>
				</section>
			)}
			{others.length > 0 && (
				<section aria-label="Agentes de otras personas">
					<h2 className="section">
						De otras personas <Badge variant="outline">Admin</Badge>
					</h2>
					<div className="agent-grid">
						{others.map((a) => (
							<AgentCard key={a.id} agent={a} people={people} onOpen={onOpen} showOwner />
						))}
					</div>
				</section>
			)}
		</div>
	);
}

/** The card's state: the run's, or the setup's while a new agent is still initializing. */
function cardStatus(agent: Agent, setup: boolean): { status: CardStatus; label: string } {
	const t = agent.task;
	if (setup)
		return t && ['error', 'cancelled', 'incomplete'].includes(t.status)
			? { status: 'review-setup', label: 'Revisar inicialización' }
			: { status: 'initializing', label: 'Inicializando' };
	if (t?.status === 'queued') return { status: 'queued', label: 'En cola' };
	const state = stateOf(agent);
	return { status: state, label: STATE_LABEL[state] };
}

function AgentCard({
	agent,
	people,
	onOpen,
	showOwner,
}: {
	agent: Agent;
	people: Map<number, Someone>;
	onOpen: (id: number) => void;
	showOwner?: boolean;
}) {
	const state = stateOf(agent);
	const { data: updates } = useComputerUpdates();
	const maintenance = !showOwner
		? updates.jobs.flatMap((j) => j.items).find((i) => i.agent_id === agent.id && updatePending(i.status))
		: null;
	const update = !showOwner
		? updates.agents.find((a) => a.id === agent.id && a.updateAvailable && !a.activeJobId)
		: null;
	const t = agent.task;
	const live = isLive(t) && t!.status !== 'queued';
	const setup = !!(!showOwner && agent.setup_design_id && (!t || (t.kind === 'initialize' && t.status !== 'done')));
	const { status, label } = cardStatus(agent, setup);
	const work = t ? `${t.id}:${t.prompt}` : 'none'; // the footer's lines change with the run
	const crew = crewOf(agent, people);
	return (
		<Card className={`agent-card relative gap-0 overflow-hidden rounded-card p-0 shadow-none state-${state}`}>
			<a
				href={setup ? `#/new/${agent.setup_design_id}` : `#/agent/${agent.id}`}
				className="agent-card-link"
				aria-label={`Abrir ${agent.name}`}
				onClick={(e) => {
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
					e.preventDefault();
					if (setup) location.hash = `/new/${agent.setup_design_id}`;
					else onOpen(agent.id);
				}}
			/>
			<div className="card-top">
				<Character seed={agent.seed} state={state} size={56} />
				<div className="card-id">
					<h2 className="name">{agent.name}</h2>
					<p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
						<StatusIcon status={status} label={label} />
						<span className="truncate">
							{showOwner ? `${agent.owner} · ` : ''}
							{agent.model.split('/')[1]}
						</span>
					</p>
				</div>
				{maintenance ? (
					<span
						role="img"
						aria-label={`Actualizando: ${UPDATE_LABEL[maintenance.status]}`}
						title={UPDATE_LABEL[maintenance.status]}
						className="shrink-0"
					>
						<LoaderCircle className="size-4 animate-spin text-warning" aria-hidden="true" />
					</span>
				) : update && updates.target ? (
					<span
						role="img"
						aria-label="Actualización disponible"
						title={`Actualización disponible: ${imageVersion(update.current)} → ${imageVersion(updates.target)}`}
						className="shrink-0"
					>
						<CircleArrowUp className="size-4 text-warning" aria-hidden="true" />
					</span>
				) : null}
				<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			</div>
			<Browser agentId={agent.id} live={live} compact />
			<div className="card-foot">
				<Ticker itemKey={work} className="flex-1">
					<span className="prompt block text-muted-foreground" title={t?.prompt}>
						{t?.prompt || 'Sin tareas todavía'}
					</span>
				</Ticker>
				<div className="flex shrink-0 flex-col items-end gap-1">
					{/* Every card has a time: the last run's, or when the agent was created. */}
					<Ticker itemKey={work}>
						<span className="block text-muted-foreground" title={t ? 'Último turno' : 'Creado'}>
							{ago(t ? t.created_at : agent.created_at)}
						</span>
					</Ticker>
					<PeopleStack people={crew} />
				</div>
			</div>
		</Card>
	);
}
