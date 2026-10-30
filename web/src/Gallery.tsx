import { ArrowUpRight, Bot, Plus } from 'lucide-react';
import { isLive, ago, type Agent, type Person, type PublicSettings } from './api';
import { Character, STATE_LABEL, type CharState } from './Character';
import { Browser } from './Browser';
import { useTick } from './live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

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
	const mine = agents.filter((a) => a.person_id === me.id);
	const shared = agents.filter((a) => a.person_id !== me.id && a.shares?.includes(me.id));
	const others = agents.filter((a) => a.person_id !== me.id && !a.shares?.includes(me.id));
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
				<Button asChild>
					<a href="#/new">
						<Plus aria-hidden="true" />
						Nuevo agente
					</a>
				</Button>
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
					<AgentCard key={a.id} agent={a} onOpen={onOpen} />
				))}
			</div>
			{shared.length > 0 && (
				<section aria-label="Compartidos contigo">
					<h2 className="section">
						Compartidos contigo <Badge variant="secondary">{shared.length}</Badge>
					</h2>
					<div className="agent-grid">
						{shared.map((a) => (
							<AgentCard key={a.id} agent={a} onOpen={onOpen} showOwner />
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
							<AgentCard key={a.id} agent={a} onOpen={onOpen} showOwner />
						))}
					</div>
				</section>
			)}
		</div>
	);
}

function AgentCard({ agent, onOpen, showOwner }: { agent: Agent; onOpen: (id: number) => void; showOwner?: boolean }) {
	const state = stateOf(agent);
	const t = agent.task;
	const live = isLive(t) && t!.status !== 'queued';
	const setup = !showOwner && agent.setup_design_id && (!t || (t.kind === 'initialize' && t.status !== 'done'));
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
					<p className="truncate text-xs text-muted-foreground">
						{showOwner ? `${agent.owner} · ` : ''}
						{agent.model.split('/')[1]}
					</p>
				</div>
				<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			</div>
			<div className="flex min-w-0 items-center gap-2 px-5 pb-4">
				<Badge variant="outline" className={`pill s-${state}`}>
					{setup
						? t && ['error', 'cancelled', 'incomplete'].includes(t.status)
							? 'Revisar inicialización'
							: 'Inicializando'
						: t?.status === 'queued'
							? 'En cola'
							: STATE_LABEL[state]}
				</Badge>
				<span className="truncate text-xs text-muted-foreground">{agent.role || 'Sin rol definido'}</span>
			</div>
			<Browser agentId={agent.id} live={live} compact />
			<div className="card-foot">
				<span className="prompt text-muted-foreground" title={t?.prompt}>
					{t?.prompt || 'Sin tareas todavía'}
				</span>
				{t && <span className="shrink-0 text-muted-foreground">{ago(t.created_at)}</span>}
			</div>
		</Card>
	);
}
