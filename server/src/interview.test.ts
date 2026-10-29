import { expect, test } from 'bun:test';
import { canReview, FALLBACK_QUESTIONS, interview, interviewReply, validateAnswers, validateQuestions, QUESTIONS_SCHEMA, type InterviewMessage } from './interview';
import { parseDesignReply } from './design-format';
const questions = FALLBACK_QUESTIONS;
const asked: InterviewMessage[] = [{ role: 'user', content: 'Compara ofertas.' }, { role: 'assistant', content: 'Aclaremos el alcance.', questions, questionRound: 1 }];
const values = { scope: { selected: ['specified'], other: '' } };
const reply = { message: 'Listo', questions: [], contract: { name: 'A', prompt: 'Contrato' }, harness: null, ready: true };
test('a model cannot skip the human interview, even with a complete contract and ready=true', () => {
 const gated = interviewReply([{ role: 'user', content: 'Ya está todo, crea directamente.' }], reply);
 expect(gated.ready).toBe(false); expect(gated.contract).toBeNull(); expect(gated.harness).toBeNull(); expect(gated.questions.length).toBe(1);
 expect(canReview({ messages: asked })).toBe(false);
});
test('unanswered questions and plain yes/chat cannot be mistaken for submitted answers', () => {
 expect(interviewReply([...asked, { role: 'user', content: 'Sí. ¿Pero cómo funciona?' }], reply).ready).toBe(false);
 expect(interview(asked).pending?.round).toBe(1);
 expect(() => validateAnswers({ round: 0, values }, interview(asked).pending)).toThrow('cambió');
 expect(() => validateAnswers({ round: 1, values: {} }, interview(asked).pending)).toThrow('todas');
 expect(() => validateAnswers({ round: 1, values: { ...values, foreign: values.scope } }, interview(asked).pending)).toThrow('todas');
});
test('only complete validated answers close a round; one round need not end the interview', () => {
 const answer = validateAnswers({ round: 1, values }, interview(asked).pending);
 const messages: InterviewMessage[] = [...asked, { role: 'user', ...answer }];
 expect(answer.content).toContain('Mi prompt ya define el alcance'); expect(interview(messages)).toEqual({ completed: 1, pending: null });
 expect(canReview({ messages })).toBe(true); expect(interviewReply(messages, reply)).toEqual(reply);
 const more = interviewReply(messages, { ...reply, questions });
 expect(more.contract).toBeNull(); expect(more.harness).toBeNull(); expect(more.ready).toBe(false);
 expect(interviewReply(messages, { ...reply, ready: false }).questions.length).toBeGreaterThan(0);
});
test('free text is explicit and bounded; unknown or duplicate options are rejected', () => {
 const pending = interview(asked).pending;
 for (const selected of [['invented'], ['specified','specified'], ['clarify','specified']]) expect(() => validateAnswers({ round: 1, values: { scope: { selected, other: '' } } }, pending)).toThrow();
 expect(() => validateAnswers({ round: 1, values: { scope: { selected: ['other'], other: ' ' } } }, pending)).toThrow();
 expect(() => validateAnswers({ round: 1, values: { scope: { selected: ['other'], other: 'x'.repeat(1001) } } }, pending)).toThrow();
 expect(() => validateAnswers({ round: 1, values: { scope: { selected: ['specified'], other: 'hidden' } } }, pending)).toThrow('Otra');
 const answer = validateAnswers({ round: 1, values: { scope: { selected: ['other'], other: '  Inventario es requisito; no reduzcas el objetivo. ' } } }, pending);
 expect(answer.content).toContain('Inventario es requisito'); expect(answer.answers.values.scope.other).not.toMatch(/^ /);
});
test('question schema still rejects unsupported fields, code, malformed shapes and oversized content', () => {
 expect(validateQuestions(questions)).toEqual(questions);
 for (const invalid of [[...questions,...questions,...questions,...questions], [{ ...questions[0], execute: 'bash' }], [{ ...questions[0], recommended: true }], [{ ...questions[0], id: 123 }], [{ ...questions[0], id: 'x'.repeat(201) }], [{ ...questions[0], title: 'x'.repeat(301) }]]) expect(() => validateQuestions(invalid)).toThrow();
});
test('fresh model IDs with underscores, repeated IDs and alias collisions cannot discard the interview', () => {
 const raw = ['pregunta_1','pregunta_1','question-1'].map((id, i) => ({ ...questions[0], id, title: `Decisión ${i + 1}` }));
 const original = structuredClone(raw), normalized = validateQuestions(raw);
 expect(new Set(normalized.map(q => q.id)).size).toBe(3);
 for (const q of normalized) expect(q.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
 expect(normalized.map(q => q.title)).toEqual(raw.map(q => q.title));
 expect(raw).toEqual(original); expect(validateQuestions(normalized)).toEqual(normalized);
});
test('option aliases preserve a unique recommendation and omit ambiguous or unknown annotations', () => {
 const q = { ...questions[0], options: [{id:'Option_A',label:'Primera',description:''},{id:'other',label:'Segunda',description:''},{id:'Option_A',label:'Tercera',description:''}], recommended:'other' };
 const [normalized] = validateQuestions([q]);
 expect(new Set(normalized.options.map(o => o.id)).size).toBe(3);
 expect(normalized.options.some(o => o.id === 'other')).toBe(false);
 expect(normalized.recommended).toBe(normalized.options[1].id);
 expect(normalized.options.map(o => o.label)).toEqual(['Primera','Segunda','Tercera']);
 expect(validateQuestions([{...q,recommended:'Option_A'}])[0].recommended).toBeNull();
 expect(validateQuestions([{...q,recommended:'missing'}])[0].recommended).toBeNull();
});
test('technical repair never rewrites saved rounds or relaxes submitted-answer validation', () => {
 const [q] = validateQuestions([{...questions[0],id:'Fuente_1',options:[{id:'opción 1',label:'Datos propios',description:''}],recommended:'opción 1'}]);
 const pending = {round:9,questions:[q]};
 expect(() => validateAnswers({round:9,values:{Fuente_1:{selected:['opción 1'],other:''}}},pending)).toThrow();
 const values = {[q.id]:{selected:[q.options[0].id],other:''}};
 expect(validateAnswers({round:9,values},pending).content).toContain('Datos propios');
 const stored = structuredClone(asked);validateQuestions([{...q,id:'otro_id'}]);expect(asked).toEqual(stored);
 expect(() => validateAnswers({round:1,values:{scope:{selected:['invented'],other:''}}},interview(asked).pending)).toThrow();
});
test('prototype/reserved keys become safe aliases and the provider schema documents the accepted ID format', () => {
 for (const id of ['constructor','prototype','__proto__','other','Pregunta 1','¿objetivo?','']) {
  const [q] = validateQuestions([{...questions[0],id,options:[{id,label:'Opción',description:''}],recommended:id}]);
  expect(['constructor','prototype','__proto__','other']).not.toContain(q.id);
  expect(q.options[0].id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);expect(q.recommended).toBe(q.options[0].id);
 }
 expect(QUESTIONS_SCHEMA.items.properties.id.pattern).toBe('^[a-z][a-z0-9-]{0,39}$');
 expect(QUESTIONS_SCHEMA.items.properties.options.items.properties.id.maxLength).toBe(40);
});
test('multi-select and independent questions keep their own option namespaces', () => {
 const multi = { ...questions[0], id: 'sources', selectionMode: 'multi' as const };
 const pending = { round: 7, questions: [...questions, multi] };
 const answer = validateAnswers({ round: 7, values: { ...values, sources: { selected: ['clarify','other'], other: 'Datos aportados' } } }, pending);
 expect(answer.answers.values.sources.selected).toEqual(['clarify','other']); expect(answer.content).toContain('Datos aportados');
});
test('an explicit restore can be reviewed without fabricating question answers', () => {
 expect(canReview({ messages: [], restored_revision: 2 })).toBe(true);
 expect(canReview({ messages: [] })).toBe(false);
});
test('Responses output accepts structured questions but never arbitrary UI markup or code', () => {
 const value = { ...reply, questions, ready: false, contract: null };
 const response = (v: unknown) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(v) }] }] });
 expect(parseDesignReply(response(value)).questions).toEqual(questions);
 expect(() => parseDesignReply(response({ ...value, questions: [{ ...questions[0], component: '<script>' }] }))).toThrow('desconocidos');
});
