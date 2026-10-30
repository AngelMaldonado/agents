import { expect, test } from 'bun:test';
import { newRunWorkflowId, admissionWorkflowId, isNewRunWorkflowId } from './run-identity';
import { assertTestDatabase } from './test-database';

test('new durable identities do not depend on reused public integer IDs', () => {
	const ids = Array.from({ length: 100 }, () => newRunWorkflowId());
	expect(new Set(ids).size).toBe(ids.length);
	for (const id of ids) {
		expect(isNewRunWorkflowId(id)).toBe(true);
		expect(admissionWorkflowId(id)).toBe(id.replace(/^run-/, 'admit-'));
	}
	expect(ids).not.toContain('run-6');
});
test('existing legacy identities keep their admission and never silently become fresh runs', () => {
	expect(admissionWorkflowId('run-6')).toBe('admit-6');
	expect(isNewRunWorkflowId('run-6')).toBe(false);
	expect(() => admissionWorkflowId('')).toThrow();
});
test('destructive tests reject a pool captured before the test environment was set', () => {
	const testUrl = 'postgres://fixture:fixture@localhost/agents_test';
	expect(() => assertTestDatabase(testUrl, testUrl, 'agents_test')).not.toThrow();
	expect(() => assertTestDatabase(testUrl, 'postgres://fixture:fixture@localhost/agents')).toThrow('abortadas');
	expect(() => assertTestDatabase(testUrl, testUrl, 'agents')).toThrow('abortadas');
	expect(() =>
		assertTestDatabase('postgres://fixture:fixture@localhost/agents', 'postgres://fixture:fixture@localhost/agents'),
	).toThrow('abortadas');
	expect(() => assertTestDatabase('invalid', 'invalid')).toThrow('válida');
});
