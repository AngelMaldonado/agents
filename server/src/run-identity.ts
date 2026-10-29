import { randomUUID } from 'node:crypto';

// Persist once with the run. Public numeric IDs can be reused after a dev reset;
// DBOS history can outlive those rows and must never deduplicate an unrelated run.
export const newRunWorkflowId = () => `run-${randomUUID()}`;
export const isNewRunWorkflowId = (id: string) => /^run-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id);
export function admissionWorkflowId(runWorkflowId: string) {
 if (!/^run-.+/.test(runWorkflowId)) throw new Error('La corrida no tiene una identidad de cola válida.');
 // Legacy run-6 keeps admit-6; never rename valid in-flight/history workflows.
 return `admit-${runWorkflowId.slice(4)}`;
}
