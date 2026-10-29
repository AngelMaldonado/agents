import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, Circle, LoaderCircle, RefreshCw, MonitorCheck } from 'lucide-react';
import { api, isLive, type Agent, type Design, type PublicSettings, type InterviewAnswers } from './api';
import { Button } from '@/components/ui/button';
const DesignChat = lazy(() => import('@/components/design-chat').then(module => ({ default: module.DesignChat })));
export { ContractMarkdown, ToolsPanel } from '@/components/design-content';

export function AgentDesigner({ settings, designId, agent, effectivePrompt, canApply = true, onDraft, onApplied, onBack, notice, active: visible = true, onResetDraft }: {
 settings: PublicSettings; designId?: string | null; agent?: Agent; effectivePrompt?: string; canApply?: boolean;
 onDraft?: (id: string) => void; onApplied: (id: number) => void; onBack?: () => void; notice?: string;
 active?: boolean; onResetDraft?: () => void;
}) {
 const [design, setDesign] = useState<Design | null>(null);
 const [model, setModel] = useState(agent?.model ?? settings.models[0]?.id ?? '');
 const [busy, setBusy] = useState(false);
 const [testing, setTesting] = useState(false);
 const [loading, setLoading] = useState(!!designId);
 const [error, setError] = useState('');
 const [session, setSession] = useState(0);
 const waitingForReply = !!design?.busy_until && design.busy_until > Date.now();
 const working = busy || waitingForReply;
 const mounted = useRef(true);
 const active = useRef<symbol | null>(null);
 const previousId = useRef(designId);
 const current = (token: symbol) => mounted.current && active.current === token;
 const clear = () => {
  active.current = null; setBusy(false); setTesting(false); setDesign(null); setError(''); setLoading(false); setModel(agent?.model ?? settings.models[0]?.id ?? ''); setSession(n => n + 1);
 };
 const reset = () => {
  if (active.current) return;
  clear(); onResetDraft?.(); location.hash = agent ? `/agent/${agent.id}/improve` : '/new';
 };
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
 useEffect(() => {
  const old = previousId.current; previousId.current = designId;
  if (!designId) { if (old && !agent) clear(); return; }
  if (design?.id === designId) return; // Assigning a just-created draft URL must not reset its composer.
  let alive = true; active.current = null; setBusy(false); setTesting(false); setDesign(null); setSession(n => n + 1); setLoading(true); setError('');
  api<{ design: Design }>(`/designs/${designId}`).then(r => {
   if (agent && r.design.agent_id !== agent.id) throw new Error('El borrador no pertenece a este agente.');
   if (alive) { setDesign(r.design); setModel(r.design.model); setError(r.design.last_error ?? ''); }
  })
   .catch(err => { if (alive) setError(err.message); }).finally(() => { if (alive) setLoading(false); });
  return () => { alive = false; };
 }, [designId]);
 // Persisted state is authoritative; polling observes replies and initialization, never simulates progress.
 useEffect(() => {
  if (!design) return;
  const waiting = design.status === 'draft' && (design.busy_until ?? 0) > Date.now();
  const initializing = design.status === 'approved' && !design.agent_id && design.initialization?.task?.status !== 'done';
  if (!waiting && !initializing) return;
  let alive = true, timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
   let again = true;
   try {
    const r = await api<{ design: Design }>(`/designs/${design.id}`);
    if (alive) { setDesign(r.design); setError(r.design.last_error ?? ''); }
    again = r.design.status === 'draft' ? (r.design.busy_until ?? 0) > Date.now() : r.design.initialization?.task?.status !== 'done';
   } catch (err) { if (alive) setError((err as Error).message); }
   if (alive && again) timer = setTimeout(poll, 1500);
  };
  timer = setTimeout(poll, 1000);
  return () => { alive = false; clearTimeout(timer); };
 }, [design?.id, design?.status, design?.busy_until, design?.initialization?.task?.status]);
 const sendMessage = async (input: { text?: string; answers?: InterviewAnswers; attachments?: { name: string; mime: string; data: string }[] }) => {
  if (active.current || working || loading || (!input.text?.trim() && !input.answers && !input.attachments?.length)) throw new Error('Espera a que termine la petición actual.');
  const token = Symbol(); active.current = token; setBusy(true); setError('');
  try {
   const d = design ?? (await api<{ design: Design }>('/designs', { body: { model, ...(agent ? { agentId: agent.id } : {}) } })).design;
   if (!current(token)) return;
   setDesign(d); onDraft?.(d.id);
   const r = await api<{ design: Design }>(`/designs/${d.id}/messages`, { body: { ...input, version: d.version } });
   if (current(token)) setDesign(r.design);
  } catch (err) { if (current(token)) setError((err as Error).message); throw err; }
  finally { if (current(token)) { active.current = null; setBusy(false); } }
 };
 const testHarness = async () => {
  if (!design?.ready || active.current || working || design.stale) return;
  const token = Symbol(); active.current = token; setBusy(true); setTesting(true); setError('');
  try { const r = await api<{ design: Design }>(`/designs/${design.id}/validate`, { body: { version: design.version } }); if (current(token)) setDesign(r.design); }
  catch (err) { if (current(token)) setError((err as Error).message); }
  finally { if (current(token)) { active.current = null; setBusy(false); setTesting(false); } }
 };
 const approve = async () => {
  if (!design?.ready || active.current || working || design.stale || !canApply) return;
  const token = Symbol(); active.current = token; setBusy(true); setError('');
  try {
   const r = await api<{ design: Design }>(`/designs/${design.id}/approve`, { body: { version: design.version } });
   if (!current(token)) return;
   setDesign(r.design); if (r.design.agent_id) onApplied(r.design.applied_agent_id!);
  } catch (err) { if (current(token)) setError((err as Error).message); }
  finally { if (current(token)) { active.current = null; setBusy(false); } }
 };
 const reload = async () => {
  if ((!designId && !design) || active.current) return;
  const token = Symbol(); active.current = token; setLoading(true); setError('');
  try { const r = await api<{ design: Design }>(`/designs/${design?.id ?? designId}`); if (agent && r.design.agent_id !== agent.id) throw new Error('El borrador no pertenece a este agente.'); if (current(token)) { setDesign(r.design); setError(r.design.last_error ?? ''); } }
  catch (err) { if (current(token)) setError((err as Error).message); }
  finally { if (current(token)) { active.current = null; setLoading(false); } }
 };
 if (design?.status === 'approved' && !design.agent_id) return <div className="page narrow py-8">
  <div className="mb-6 flex items-center gap-3"><MonitorCheck className="size-6 text-primary" aria-hidden="true" /><div><h1>Inicializando {design.contract?.name}</h1><p className="muted mt-1">Contrato aprobado. Estamos comprobando su computadora.</p></div></div>
  <Initialization design={design} busy={busy} onRetry={async () => {
   if (active.current) return;
   const token = Symbol(); active.current = token; setBusy(true); setError('');
   try { const r = await api<{ design: Design }>(`/designs/${design.id}/initialize`, { body: { runId: design.init_run_id } }); if (current(token)) setDesign(r.design); }
   catch (err) { if (current(token)) setError((err as Error).message); }
   finally { if (current(token)) { active.current = null; setBusy(false); } }
  }} />
  {error && <p role="alert" className="error mt-3">{error}</p>}
  <div className="mt-5 flex flex-wrap gap-2">
   {onBack && <Button variant="outline" onClick={onBack}>Volver a agentes</Button>}
   {design.initialization?.task?.status === 'done' && <Button onClick={() => onApplied(design.applied_agent_id!)}>Abrir agente<CheckCheck aria-hidden="true" /></Button>}
  </div>
  <p className="mt-4 text-xs text-muted-foreground">La comprobación usa la cola y cuota normales. Al terminar se apaga esta computadora; las tareas arrancarán otra sobre la misma memoria.</p>
 </div>;
 return <Suspense fallback={<div className="p-5 text-xs text-muted-foreground" role="status">Cargando conversación…</div>}><DesignChat key={session} design={design} agent={agent} effectivePrompt={effectivePrompt} settings={settings} model={model} onModel={setModel} working={working} loading={loading} canApply={canApply} error={error} onReload={() => void reload()} onReset={reset} onSend={(text, attachments) => sendMessage({ text, ...(attachments?.length ? { attachments } : {}) })} onAnswer={answers => sendMessage({ answers })} onApprove={() => void approve()} onValidate={() => void testHarness()} validating={testing} onBack={onBack} notice={notice} active={visible} /></Suspense>;
}

function Initialization({ design, busy, onRetry }: { design: Design; busy: boolean; onRetry: () => void }) {
 const init = design.initialization;
 const complete = init?.task?.status === 'done';
 const failed = !init?.task || (!isLive(init.task) && !complete);
 const steps = init?.steps ?? [];
 const count = steps.filter(s => s.done).length;
 const current = steps.findIndex(s => !s.done);
 const percent = steps.length ? Math.round(count / steps.length * 100) : 0;
 return <section aria-label="Progreso de inicialización" className="rounded-card border bg-card p-5">
  <div className="mb-3 flex items-center justify-between text-xs"><span>{complete ? 'Listo para trabajar' : failed ? 'Necesita atención' : init?.task?.status === 'queued' ? 'Esperando turno en la cola' : 'Preparando el entorno'}</span><span className="tnum">{count}/{steps.length} pasos</span></div>
  <div role="progressbar" aria-label="Inicialización del agente" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${count} de ${steps.length} pasos completados`} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} /></div>
  <ol className="mt-5 grid gap-4">{steps.map((step, i) => <li key={step.id} className="flex items-center gap-3 text-xs" aria-current={!complete && i === current ? 'step' : undefined}>
   {step.done ? <Check className="size-4 shrink-0 text-success" aria-hidden="true" /> : !failed && i === current ? <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" /> : <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}<span className={step.done ? 'text-foreground' : 'text-muted-foreground'}>{step.label}</span><span className="sr-only">{step.done ? 'Completado' : 'Pendiente'}</span>
  </li>)}</ol>
  {failed && !complete && <div className="mt-5"><p role="alert" className="error mb-3">{init?.error ?? 'No se pudo iniciar la comprobación.'}</p><Button variant="outline" size="sm" onClick={onRetry} disabled={busy}><RefreshCw />{busy ? 'Reintentando…' : 'Reintentar inicialización'}</Button></div>}
  <p role="status" className="sr-only">{complete ? 'Agente inicializado.' : `${count} de ${steps.length} pasos completados.`}</p>
 </section>;
}
