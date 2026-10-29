import { expect, test } from 'bun:test';
import { validateContract, parseDesignReply, INIT_STEPS } from './design-format';
const response = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
test('contract validates without silently truncating the prompt', () => {
 expect(validateContract({ name: ' Compras ', prompt: '# Objetivo\nComparar fuentes.' })).toEqual({ name: 'Compras', prompt: '# Objetivo\nComparar fuentes.' });
 expect(() => validateContract({ name: 'x'.repeat(41), prompt: 'a' })).toThrow();
 expect(() => validateContract({ name: 'a', prompt: 'x'.repeat(16001) })).toThrow();
});
test('interview can ask questions before there is a contract', () => {
 expect(parseDesignReply(response({ message: '¿Qué resultado esperas?', contract: null, ready: false })).ready).toBe(false);
});
test('a ready response must include a non-empty contract', () => {
 expect(() => parseDesignReply(response({ message: 'Listo', contract: null, ready: true }))).toThrow('vacío');
 expect(() => parseDesignReply(response({ message: 'Listo', contract: { name: 'A', prompt: '' }, ready: true }))).toThrow();
});
test('rejects truncation, refusals, invalid JSON and arbitrary model fields instead of applying them', () => {
 expect(() => parseDesignReply({ status: 'incomplete', output: [] })).toThrow('no terminó');
 expect(() => parseDesignReply({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }] })).toThrow('válido');
 expect(() => parseDesignReply(response({ message: 'x', contract: null, ready: 'true' }))).toThrow();
 const parsed = parseDesignReply(response({ message: 'Revisa', contract: { name: 'A', prompt: 'Rol', admin: true }, ready: true, execute: 'rm -rf /' }));
 expect(parsed).toEqual({ message: 'Revisa', contract: { name: 'A', prompt: 'Rol' }, harness: null, ready: true, questions: [] });
});
test('initialization ends with readiness, not with merely opening Chrome', () => {
 expect(INIT_STEPS.map(s => s.id)).toEqual(['contract', 'computer', 'workspace', 'tools', 'browser', 'ready']);
});
