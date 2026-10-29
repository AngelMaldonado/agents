import { useRef } from 'react';
import type { Question, InterviewAnswers } from '@/api';
import { QuestionFlow } from '@/components/tool-ui/question-flow';
import { Textarea } from '@/components/ui/textarea';
export type QuestionDraft = { value: Record<string, string[]>; other: Record<string, string>; step?: string; error?: string };
export function Questionnaire({ id, round, questions, answered, draft, update, onAnswer, blocked, working, unsent = false, legend, receiptTitle = 'Respuestas enviadas' }: {
 id: string; round: number; questions: Question[]; answered?: InterviewAnswers; draft: QuestionDraft;
 update: (patch: Partial<QuestionDraft>) => void; onAnswer: (answers: InterviewAnswers) => Promise<void>;
 blocked: boolean; working: boolean; unsent?: boolean; legend: string; receiptTitle?: string;
}) {
 const root = useRef<HTMLDivElement>(null), sending = useRef(false);
 if (answered) return <QuestionFlow id={id} choice={{ title: receiptTitle, summary: questions.map(q => ({ label: q.title, value: (answered.values[q.id]?.selected ?? []).map(option => option === 'other' ? answered.values[q.id].other : q.options.find(o => o.id === option)?.label ?? option).join('; ') })) }} />;
 const steps = questions.map(q => ({ ...q, options: [...q.options.map(o => ({ ...o, label: o.label + (q.recommended === o.id ? ' · Recomendada' : '') })), { id: 'other', label: 'Otra respuesta', description: 'Escribir mi propia respuesta.' }] }));
 const submit = async (value: Record<string, string[]>) => {
  if (sending.current || blocked) return;
  sending.current = true; update({ error: '' });
  try { await onAnswer({ round, values: Object.fromEntries(questions.map(q => [q.id, { selected: value[q.id] ?? [], other: value[q.id]?.includes('other') ? (draft.other[q.id] ?? '').trim() : '' }])) }); }
  catch (err) { update({ error: (err as Error).message }); }
  finally { sending.current = false; }
 };
 return <div ref={root} className="mt-4 min-w-0" data-interview-round={round}>
  <fieldset disabled={blocked} aria-busy={working} className="m-0 min-w-0 border-0 p-0" onKeyDownCapture={e => { if (blocked) { e.preventDefault(); e.stopPropagation(); } }}>
   <legend className="sr-only">{legend}</legend>
   <QuestionFlow id={id} steps={steps} value={draft.value} activeStepId={draft.step}
    onValueChange={value => update({ value, error: '' })}
    onStepChange={step => { update({ step }); requestAnimationFrame(() => root.current?.querySelector<HTMLHeadingElement>('[aria-hidden="false"] h2')?.focus()); }}
    isValid={step => !draft.value[step]?.includes('other') || !!draft.other[step]?.trim()}
    renderInput={step => draft.value[step]?.includes('other') ? <div className="min-w-0 space-y-2"><label htmlFor={`${id}:${step}:other`} className="text-xs font-medium">Tu respuesta</label><Textarea id={`${id}:${step}:other`} value={draft.other[step] ?? ''} maxLength={1000} rows={3} placeholder="Escribe lo que necesitas, sin contraseñas ni tokens…" onChange={e => update({ other: { ...draft.other, [step]: e.target.value }, error: '' })} /><p className="text-2xs text-muted-foreground">No se envía hasta pulsar Enviar respuestas al final de esta ronda.</p></div> : null}
    onComplete={submit} />
  </fieldset>
  {working && <p role="status" className="mt-2 text-xs text-muted-foreground">Enviando respuestas…</p>}
  {unsent && <p className="mt-2 text-xs text-muted-foreground">Envía o borra el mensaje del prompt antes de enviar estas respuestas.</p>}
  {draft.error && <p role="alert" className="mt-2 text-xs text-destructive">{draft.error} Tus selecciones y texto se conservan para reintentar.</p>}
 </div>;
}
