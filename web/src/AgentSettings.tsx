import { lazy, Suspense, useState, type ReactNode } from 'react';
import { CalendarDays, Globe, Settings2, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api, isLive, type Agent, type PublicSettings } from './api';
import { AgentConfiguration } from './AgentConfiguration';
import { Channels } from './Channels';
import { AgentSchedules } from './AgentSchedules';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { OptionSelect } from '@/components/option-select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
const RoleEditor = lazy(() => import('@/components/role-editor').then(module => ({ default: module.RoleEditor })));

export function AgentSettings({ agent, settings, mine, profileReset, onProfileReset, onChanged, onDeleted }: {
 agent: Agent; settings: PublicSettings; mine: boolean; profileReset: boolean;
 onProfileReset: (pending: boolean) => void; onChanged: () => void; onDeleted: () => void;
}) {
 const [open, setOpen] = useState(false);
 const [tab, setTab] = useState('general');
 const [visited, setVisited] = useState(new Set(['general']));
 const changeTab = (value: string) => { setTab(value); setVisited(tabs => new Set([...tabs, value])); };
 return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) { setTab('general'); setVisited(new Set(['general'])); } }}>
  <DialogTrigger asChild><Button variant="outline" size="sm" aria-label="Configuración del agente" title="Configuración del agente"><Settings2 /><span className="agent-action-label">Configuración</span></Button></DialogTrigger>
  <DialogContent onEscapeKeyDown={event => { if ((event.target as Element)?.closest('.role-editor[data-vim-enabled="true"] .cm-editor')) event.preventDefault(); }} className="agent-settings-dialog flex h-[min(46rem,calc(100svh-2rem))] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
   <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12"><DialogTitle>Configuración</DialogTitle><DialogDescription className="break-words">{agent.name}{!mine && ' · Sólo lectura'}</DialogDescription></DialogHeader>
   <Tabs orientation="vertical" value={tab} onValueChange={changeTab} className="agent-settings-tabs min-h-0 flex-1 gap-0">
    <div className="agent-settings-nav">
     <TabsList aria-label="Secciones de configuración" className="w-full items-stretch bg-transparent p-0">
      <TabsTrigger value="general" aria-label="General"><Settings2 /><span>General</span></TabsTrigger>
      {mine && <TabsTrigger value="channels" aria-label="Canales"><Globe /><span>Canales</span></TabsTrigger>}
      {mine && <TabsTrigger value="schedules" aria-label="Horarios"><CalendarDays /><span>Horarios</span></TabsTrigger>}
      {mine && <TabsTrigger value="advanced" aria-label="Avanzado"><SlidersHorizontal /><span>Avanzado</span></TabsTrigger>}
     </TabsList>
    </div>
    <SettingsPanel value="general" active={tab}><AgentConfiguration agent={agent} settings={settings} mine={mine} onRestore={() => { setOpen(false); setTab('general'); setVisited(new Set(['general'])); }} /></SettingsPanel>
    {mine && visited.has('channels') && <SettingsPanel value="channels" active={tab}><Channels agentId={agent.id} /></SettingsPanel>}
    {mine && visited.has('schedules') && <SettingsPanel value="schedules" active={tab}><AgentSchedules agentId={agent.id} /></SettingsPanel>}
    {mine && visited.has('advanced') && <SettingsPanel value="advanced" active={tab}>
     <h2 className="mb-2">Edición manual</h2><p className="mb-4 text-xs text-muted-foreground">Modifica directamente el nombre, contrato y modelo. Para revisar una propuesta con IA, abre Automejora junto al botón Historial.</p>
     <EditAgent key={agent.config_revision} agent={agent} settings={settings} onSaved={() => { changeTab('general'); onChanged(); }} />
     <BrowserProfile agent={agent} pending={profileReset} onPending={onProfileReset} />
     <RetireAgent agent={agent} onDeleted={onDeleted} />
    </SettingsPanel>}
   </Tabs>
  </DialogContent>
 </Dialog>;
}

function SettingsPanel({ value, active, children }: { value: string; active: string; children: ReactNode }) {
 return <TabsContent value={value} forceMount hidden={active !== value} className="agent-settings-panel"><ScrollArea type="auto" className="agent-settings-scroll h-full min-w-0"><div className="agent-settings-content">{children}</div></ScrollArea></TabsContent>;
}

function EditAgent({ agent, settings, onSaved }: { agent: Agent; settings: PublicSettings; onSaved: () => void }) {
 const [name, setName] = useState(agent.name);
 const [role, setRole] = useState(agent.role);
 const [model, setModel] = useState(agent.model);
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const live = isLive(agent.task);
 const perform = async (operation: () => Promise<void>) => {
  if (busy || live) return;
  setBusy(true); setError('');
  try { await operation(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
 };
 return <form className="form mb-6" onSubmit={e => { e.preventDefault(); void perform(async () => {
  await api(`/agents/${agent.id}`, { method: 'PATCH', body: { name, role, model, revision: agent.config_revision } }); onSaved();
 }); }}>
  {live && <p role="status" className="callout text-xs">La edición manual espera a que termine la corrida activa.</p>}
  <fieldset disabled={busy || live} className="grid min-w-0 gap-4">
   <label>Nombre<Input value={name} onChange={e => setName(e.target.value)} maxLength={40} required /></label>
   <Suspense fallback={<p role="status" className="muted">Cargando editor…</p>}><RoleEditor value={role} onChange={setRole} disabled={busy || live} /></Suspense>
   <label>Modelo<OptionSelect label="Modelo del agente" value={model} onValueChange={setModel} options={settings.models} disabled={busy || live} /></label>
   <div className="row wrap"><Button>Guardar cambios</Button></div>
  </fieldset>
  {error && <p role="alert" className="error">{error}</p>}
 </form>;
}

function BrowserProfile({ agent, pending, onPending }: { agent: Agent; pending: boolean; onPending: (value: boolean) => void }) {
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 return <section className="border-t pt-5"><h2>Perfil del navegador</h2><p className="mb-3 mt-2 text-xs text-muted-foreground">Borra cookies, sesiones y almacenamiento del navegador en la siguiente tarea. No reinicia la conversación ni elimina el workspace.</p>
  <Button variant="danger-outline" size="sm" className="h-auto min-h-control-sm whitespace-normal" disabled={busy || pending} onClick={async () => {
   if (!confirm('¿Borrar el perfil del navegador? Se pierden las sesiones iniciadas; se aplica al empezar su siguiente tarea.')) return;
   setBusy(true); setError('');
   try { const r = await api(`/agents/${agent.id}/profile/reset`, { method: 'POST' }); onPending(r.profileResetPending); }
   catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }}>{pending ? 'Perfil: borrado pendiente' : 'Borrar perfil del navegador'}</Button>
  {error && <p role="alert" className="error mt-3">{error}</p>}
 </section>;
}

function RetireAgent({ agent, onDeleted }: { agent: Agent; onDeleted: () => void }) {
 const [open, setOpen] = useState(false);
 const [confirmation, setConfirmation] = useState('');
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 const live = isLive(agent.task);
 return <section className="mt-8 rounded-lg border border-destructive/30 bg-danger-soft/30 p-4" aria-label="Zona de peligro">
  <h2 className="text-danger-on-soft">Retirar agente</h2><p className="mb-4 mt-2 text-xs text-muted-foreground">La acción más crítica: retira el agente de la galería y elimina sus horarios. Los datos no se purgan físicamente.</p>
  <Dialog open={open} onOpenChange={value => { if (busy) return; setOpen(value); setConfirmation(''); setError(''); }}>
   <DialogTrigger asChild><Button variant="destructive" disabled={live}><Trash2 aria-hidden="true" />Retirar agente</Button></DialogTrigger>
   <DialogContent className="sm:max-w-lg" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>¿Retirar a {agent.name}?</DialogTitle><DialogDescription>Se retirará de la galería y se eliminarán sus horarios. Para confirmar, escribe su nombre exacto.</DialogDescription></DialogHeader>
    <form className="form" onSubmit={async event => {
     event.preventDefault(); if (busy || live || confirmation !== agent.name) return;
     setBusy(true); setError('');
     try { await api(`/agents/${agent.id}`, { method: 'DELETE', body: { confirmName: confirmation } }); onDeleted(); }
     catch (err) { setError((err as Error).message); } finally { setBusy(false); }
    }}>
     <label>Escribe {agent.name}<Input aria-label="Nombre del agente para confirmar" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
     {error && <p role="alert" className="error">{error}</p>}
     <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancelar</Button><Button variant="destructive" disabled={busy || live || confirmation !== agent.name}>{busy ? 'Retirando…' : 'Confirmar retiro'}</Button></div>
    </form>
   </DialogContent>
  </Dialog>
  {live && <p className="mt-3 text-xs text-muted-foreground">Termina o cancela la corrida activa antes de retirarlo.</p>}
 </section>;
}
