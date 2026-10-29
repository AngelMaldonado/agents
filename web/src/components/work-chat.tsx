import {createContext,useCallback,useContext,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {AssistantRuntimeProvider,ComposerPrimitive,MessagePrimitive,ThreadPrimitive,useAuiState,useExternalStoreRuntime,MessageNotSentError} from '@assistant-ui/react';
import {ArrowUp,MessageSquare} from 'lucide-react';
import {api,isLive,type Agent,type Artifact,type Task,type TaskEvent,type WorkRecord,type ConversationInput,type Conversation,type InterviewAnswers,type Question} from '@/api';
import {workTranscript,type WorkBinding} from '@/lib/work-transcript';
import {ArtifactMarkdown,ArtifactCards} from './artifacts';
import {Questionnaire,type QuestionDraft} from './questionnaire';
import {ConversationTabs} from './conversation-tabs';
import {Button} from './ui/button';
import {ScrollArea} from './ui/scroll-area';
type Props={agent:Agent&{mine:boolean};task:Task|null;events:TaskEvent[];files:Artifact[];historical:boolean;active:boolean;onRefresh:()=>Promise<void>;
 conversation?:Conversation;conversations?:Conversation[];records?:WorkRecord[];inputs?:ConversationInput[];loading?:boolean;loadError?:string;
 onSelect?:(id:number)=>Promise<void>;onCreate?:()=>Promise<void>;onArchive?:(id:number,archived:boolean)=>Promise<void>;onLoadEarlier?:()=>Promise<void>;hasEarlier?:boolean;waitingForComputer?:boolean};
type ChatContext={unsent:boolean;instanceId:string;props:Props;bindings:Map<string,WorkBinding>;lastByRun:Map<number,string>;busy:boolean;error:string;onAnswer:(taskId:number,a:InterviewAnswers)=>Promise<void>;drafts:Record<string,QuestionDraft>;updateDraft:(key:string,patch:Partial<QuestionDraft>)=>void};
const Context=createContext<ChatContext|null>(null);
function WorkMessage(){
 const {unsent,instanceId,props,bindings,lastByRun,busy,error,onAnswer,drafts,updateDraft}=useContext(Context)!;
 const role=useAuiState(s=>s.message.role);
 const id=useAuiState(s=>s.message.id),binding=bindings.get(id),record=binding?.record,event=binding?.event,task=record?.task;
 const blocked=event?.kind==='blocked'?event:null;
 const receipt=blocked?record?.events.find(e=>e.kind==='help_answer'&&e.data.round===blocked.id):null;
 const textReply=blocked?record?.events.find(e=>e.kind==='help_reply'&&e.data.round===blocked.id):null;
 const control=record?[...record.events].reverse().find(e=>['blocked','steer','unblocked'].includes(e.kind)):null;
 const expired=!!blocked&&record?.events.some(e=>e.kind==='help_expired'&&e.data.round===blocked.id);
 const pending=!!blocked&&task?.status==='blocked'&&control?.kind==='blocked'&&control.id===blocked.id;
 const questions:Question[]=Array.isArray(blocked?.data.questions)?blocked.data.questions:[];
 const editable=props.agent.mine&&!props.historical&&props.active&&!props.conversation?.archived_at;
 const draftKey=task&&blocked?`${task.id}:${blocked.id}`:'';
 return <MessagePrimitive.Root className={`work-message designer-message designer-message-${role}`}>
  <span className="sr-only">{role==='user'?'Tú':'Agente'}</span>
  <div className="work-message-body designer-message-content"><MessagePrimitive.Parts components={{Text:({text})=><ArtifactMarkdown text={text} agentId={props.agent.id} runId={task?.id??0} files={record?.artifacts??[]}/>}}/></div>
  {binding?.pending&&<p className="text-xs text-muted-foreground" role="status">Mensaje pendiente; se entregará sólo en esta conversación.</p>}
  {blocked&&task&&<div className="work-questionnaire" data-help-round={blocked.id}>
   {questions.length>0&&!textReply&&(!pending&&!receipt)?<details className="mt-3 text-xs text-muted-foreground"><summary>Solicitud anterior · ya terminó</summary><ul className="mt-2 list-disc pl-4">{questions.map(q=><li key={q.id}>{q.title}</li>)}</ul></details>:questions.length>0&&!textReply?<Questionnaire key={draftKey} id={`${instanceId}:help:${draftKey}`} round={blocked.id} questions={questions} answered={receipt?.data.answers} draft={drafts[draftKey]??{value:{},other:{}}} update={patch=>updateDraft(draftKey,patch)} onAnswer={a=>onAnswer(task.id,a)} blocked={!editable||!pending||busy||unsent||!!expired} working={busy} unsent={unsent} legend="Respuesta al agente" receiptTitle={expired?'Respuesta guardada, no entregada':pending?'Respuestas guardadas; esperando entrega':'Respuestas enviadas'}/>:pending&&!textReply?<p className="text-sm text-muted-foreground">Responde escribiendo en el chat.</p>:null}
   {textReply&&pending&&<p className="text-xs text-muted-foreground" role="status">Respuesta guardada; esperando entrega.</p>}
  </div>}
  {task&&id===lastByRun.get(task.id)&&<ArtifactCards files={record?.artifacts??[]} agentId={props.agent.id} runId={task.id}/>}
 </MessagePrimitive.Root>;
}
export function WorkChat(props:Props){
 const {agent,task,historical,active,onRefresh,conversation}=props;
 const instanceId=useId();
 const viewport=useRef<HTMLDivElement>(null),scrollMemory=useRef<{top:number;atBottom:boolean}|null>(null);
 const [followEnabled,setFollowEnabled]=useState(active);
 useLayoutEffect(()=>{
  if(!active){setFollowEnabled(false);return;}
  const el=viewport.current,saved=scrollMemory.current;
  if(el&&saved){
   // Hidden elements look "at bottom" to the library's ResizeObserver. Restore reader intent
   // while following is paused, then let assistant-ui resume its normal scroll behavior.
   el.scrollTop=saved.atBottom?el.scrollHeight:saved.top;
   el.dispatchEvent(new Event('scroll'));
  }
  setFollowEnabled(true);
 },[active]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const sending=useRef(false);
 const [drafts,setDrafts]=useState<Record<string,QuestionDraft>>({});
 const draftRef=useRef(drafts);draftRef.current=drafts;
 const updateDraft=(key:string,patch:Partial<QuestionDraft>)=>setDrafts(old=>({...old,[key]:{...(old[key]??{value:{},other:{}}),...patch}}));
 const records=useMemo(()=>props.records??(task?[{task,events:props.events,artifacts:props.files}]:[]),[props.records,task,props.events,props.files]);
 const transcript=useMemo(()=>workTranscript(records,props.inputs??[]),[records,props.inputs]);
 const current=useRef(props);current.current=props;
 const request=useRef<{key:string;text:string;replyTo?:{runId:number;round:number}}|null>(null);
 const composingIntent=useRef<{runId:number;round:number}|null|undefined>(undefined);
 const replyTarget=()=>{
  const p=current.current,control=[...p.events].reverse().find(e=>['blocked','steer','unblocked'].includes(e.kind));
  return p.task&&isLive(p.task)&&control?.kind==='blocked'&&!p.events.some(e=>['help_answer','help_reply'].includes(e.kind)&&e.data.round===control.id)?{runId:p.task.id,round:control.id}:null;
 };
 const newMessage=useCallback(async(message:{content:readonly {type:string;text?:string}[]})=>{
  const p=current.current,text=message.content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n').trim();
  if(!text||!p.agent.mine||p.historical||!p.active||!p.conversation||p.conversation.archived_at||p.loading)throw new MessageNotSentError('No puedes enviar en esta vista.');
  if(sending.current)throw new MessageNotSentError('Espera a que termine la petición actual.');
  if(text.length>4000)throw new MessageNotSentError('El mensaje es demasiado largo. Máximo 4000 caracteres.');
  sending.current=true;setBusy(true);setError('');
  if(!request.current||request.current.text!==text){
   const replyTo=composingIntent.current===undefined?replyTarget():composingIntent.current;
   request.current={key:crypto.randomUUID(),text,...(replyTo?{replyTo}:{})};
  }
  try{
   const r=request.current;
   await api(`/agents/${p.agent.id}/conversations/${p.conversation.id}/messages`,{method:'POST',body:{text,requestId:r.key,...(r.replyTo?{replyTo:r.replyTo}:{})}});
   request.current=null;composingIntent.current=undefined;
   // A durable acknowledgement wins even if refreshing the transcript fails; never resend an accepted message.
   await p.onRefresh().catch(()=>{});
  }catch(e){setError((e as Error).message);throw new MessageNotSentError((e as Error).message);}finally{sending.current=false;setBusy(false);}
 },[]);
 const list=useMemo(()=>props.conversations?.map(c=>({id:String(c.id),title:c.title||'Conversación',archived:!!c.archived_at})),[props.conversations]);
 const runtime=useExternalStoreRuntime({messages:transcript.messages,convertMessage:m=>m,isRunning:busy,isDisabled:!agent.mine||historical||!active||!conversation||!!props.loading||!!props.loadError||!!conversation?.archived_at,
  onNew:newMessage,adapters:list?{threadList:{threadId:conversation?String(conversation.id):'no-open-conversation',threads:list.filter(c=>!c.archived||!agent.mine).map(c=>({id:c.id,title:c.title,status:'regular' as const})),archivedThreads:agent.mine?list.filter(c=>c.archived).map(c=>({id:c.id,title:c.title,status:'archived' as const})):[],
   onSwitchToThread:async id=>{try{await current.current.onSelect?.(Number(id));}catch(e){setError((e as Error).message);}},onSwitchToNewThread:agent.mine?async()=>{setError('');try{await current.current.onCreate?.();}catch(e){setError((e as Error).message);}}:undefined,
   onArchive:agent.mine?async id=>{setError('');try{await current.current.onArchive?.(Number(id),true);}catch(e){setError((e as Error).message);}}:undefined,onUnarchive:agent.mine?async id=>{setError('');try{await current.current.onArchive?.(Number(id),false);}catch(e){setError((e as Error).message);}}:undefined}}:undefined});
 const hasText=useRef(false),[unsent,setUnsent]=useState(false);
 useEffect(()=>{
  const composer=runtime.thread.composer;
  return composer.subscribe(()=>{hasText.current=composer.getState().text.trim().length>0;setUnsent(hasText.current);});
 },[runtime]);
 useEffect(()=>{
  const guard=(e:BeforeUnloadEvent)=>{if(hasText.current||Object.values(draftRef.current).some(d=>Object.values(d.value).some(v=>v.length)||Object.values(d.other).some(v=>v.trim()))){e.preventDefault();e.returnValue='';}};
  window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
 },[]);
 const onAnswer=async(taskId:number,answers:InterviewAnswers)=>{
  const p=current.current;if(!p.agent.mine||p.historical||!p.active)return;
  if(sending.current)throw new Error('Espera a que termine la petición actual.');
  sending.current=true;setBusy(true);setError('');
  try{await api(`/tasks/${taskId}/help`,{method:'POST',body:answers});await p.onRefresh().catch(()=>{});}catch(e){setError((e as Error).message);throw e;}finally{sending.current=false;setBusy(false);}
 };
 useEffect(()=>{
  const answered=new Set(records.flatMap(r=>r.events.filter(e=>['help_answer','help_reply'].includes(e.kind)).map(e=>`${r.task.id}:${e.data.round}`)));
  setDrafts(ds=>Object.keys(ds).some(k=>answered.has(k))?Object.fromEntries(Object.entries(ds).filter(([k])=>!answered.has(k))):ds);
 },[records]);
 return <AssistantRuntimeProvider runtime={runtime}><Context.Provider value={{unsent,instanceId,props,bindings:transcript.bindings,lastByRun:transcript.lastByRun,busy,error,onAnswer,drafts,updateDraft}}>
  <ThreadPrimitive.Root className="work-chat designer-thread" data-empty={transcript.messages.length===0}>
   {list&&<ConversationTabs readOnly={!agent.mine} disabled={busy}/>}
   <ScrollArea type="auto" className="designer-thread-scroll" viewportProps={{asChild:true}}><ThreadPrimitive.Viewport ref={viewport} className="designer-thread-viewport work-chat-viewport" autoScroll={active&&followEnabled} onScroll={e=>{const el=e.currentTarget;if(current.current.active&&el.clientHeight)scrollMemory.current={top:el.scrollTop,atBottom:el.scrollHeight-el.clientHeight-el.scrollTop<4};}} turnAnchor="bottom" tabIndex={0} aria-label="Conversación de trabajo">
    <div className="designer-thread-content work-chat-messages" role="log" aria-live={active?'polite':'off'}>
     {props.hasEarlier&&<Button variant="ghost" size="sm" disabled={!!props.loading} onClick={()=>void props.onLoadEarlier?.()}>Cargar mensajes anteriores</Button>}
     {props.loading&&!props.loadError&&<p role="status" className="text-sm text-muted-foreground">Cargando conversación…</p>}
     {props.loadError&&<div role="alert" className="error">{props.loadError}<Button variant="ghost" size="sm" onClick={()=>void onRefresh()}>Reintentar</Button></div>}
     {transcript.messages.length===0&&!props.loading&&!props.loadError&&<div className="work-chat-empty"><MessageSquare aria-hidden="true"/><h2>{historical?'Conversación guardada':'¿Qué quieres resolver?'}</h2><p>{historical?'Esta ejecución no tiene mensajes de trabajo.':`Escribe a ${agent.name}. Puedes continuar aquí después de cada ejecución.`}</p>{conversation&&!conversation.is_default&&<p>Este chat tiene su propio contexto. Comparte archivos y navegador con las demás conversaciones; el agente trabaja en una a la vez. Los canales y horarios continúan en Principal.</p>}</div>}
     <ThreadPrimitive.Messages components={{UserMessage:WorkMessage,AssistantMessage:WorkMessage}}/>
    </div>
   </ThreadPrimitive.Viewport></ScrollArea>
   <div className="work-composer designer-composer-wrap">
    {error&&<p role="alert" className="error mb-2">{error}</p>}
    {historical?<p className="text-sm text-muted-foreground">Ejecución histórica · sólo lectura. Vuelve a la conversación para continuar.</p>:!agent.mine?<p className="text-sm text-muted-foreground">Sólo el dueño puede dirigir este trabajo.</p>:!conversation?<p className="text-sm text-muted-foreground">Abre una nueva conversación o retoma una desde Recientes. Las anteriores se conservan.</p>:conversation.archived_at?<p className="text-sm text-muted-foreground">Tab cerrado. Reábrelo desde Recientes para continuar.</p>:<>
     <ComposerPrimitive.Root className="designer-composer" onSubmitCapture={e=>{if(busy){e.preventDefault();e.stopPropagation();}}}>
      <ComposerPrimitive.Input aria-label="Mensaje al agente" placeholder={task?.status==='blocked'?'Responde al agente…':props.waitingForComputer?'Escribe; tu mensaje esperará su turno…':task&&isLive(task)?'Escribe; el mensaje quedará pendiente…':'Escribe al agente…'} className="designer-composer-input" minRows={2} maxRows={6} maxLength={4000} submitMode="enter" autoFocus={false} addAttachmentOnPaste={false} onChange={e=>{if(!e.target.value.trim()){composingIntent.current=undefined;request.current=null;}else if(composingIntent.current===undefined)composingIntent.current=replyTarget();}}/>
      <div className="designer-composer-actions justify-end!"><ComposerPrimitive.Send asChild><Button size="icon" aria-label="Enviar mensaje" disabled={busy||!!props.loading}><ArrowUp aria-hidden="true"/></Button></ComposerPrimitive.Send></div>
     </ComposerPrimitive.Root>
     <p className="text-xs text-muted-foreground">{props.waitingForComputer?'El agente trabaja en otra conversación. Tu mensaje esperará su turno.':task&&isLive(task)?'El agente está trabajando. Los mensajes se entregan sólo a esta conversación.':'Una conversación puede continuar durante varias ejecuciones.'}</p>
    </>}
   </div>
  </ThreadPrimitive.Root>
 </Context.Provider></AssistantRuntimeProvider>;
}
