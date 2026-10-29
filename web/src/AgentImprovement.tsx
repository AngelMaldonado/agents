import { useState } from 'react';
import { isLive, type Agent, type PublicSettings } from './api';
import { AgentDesigner } from './AgentDesigner';
import { useAgentConfiguration } from './AgentConfiguration';
import { Button } from '@/components/ui/button';

type Props = {
 agent: Agent; settings: PublicSettings; mine: boolean; active: boolean; designId?: string;
 onDraft: (id: string) => void; onResetDraft: () => void; onChanged: () => void;
};

/** Content of the agent's improvement mode, never a second page or a second header. */
export function AgentImprovement(props: Props) {
 // Observing an agent as admin does not confer the owner's GPT identity.
 if (!props.mine) return <p className="muted py-4">Sólo el dueño puede conversar y aprobar mejoras para este agente.</p>;
 return <OwnerImprovement {...props} />;
}

function OwnerImprovement({ agent, settings, designId, active, onDraft, onResetDraft, onChanged }: Props) {
 const { data, error, retry } = useAgentConfiguration(agent);
 const [applied, setApplied] = useState(false);
 const [resumeStoredDraft, setResumeStoredDraft] = useState(true);
 if (!data) return error ? <p role="alert" className="error py-4">{error} <Button variant="outline" size="sm" onClick={retry}>Reintentar</Button></p> : <p role="status" className="muted py-4">Cargando configuración…</p>;
 return <>
  {error && <p role="alert" className="error mb-3">{error} <Button variant="outline" size="sm" onClick={retry}>Reintentar configuración</Button></p>}
  <AgentDesigner settings={settings} agent={{ ...agent, ...data.agent }} effectivePrompt={data.effectivePrompt} designId={designId ?? (resumeStoredDraft ? data.draftId : undefined)} active={active} canApply={!isLive(agent.task)} onDraft={id => { setResumeStoredDraft(false); setApplied(false); onDraft(id); }} onResetDraft={() => { setResumeStoredDraft(false); setApplied(false); onResetDraft(); }} onApplied={() => { setApplied(true); retry(); onChanged(); }} notice={applied ? 'Mejora aprobada y aplicada. Las siguientes tareas usarán este contrato; la conversación, workspace y perfil se conservan.' : undefined} />
 </>;
}
