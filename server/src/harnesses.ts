import { createHash } from 'node:crypto';
import { exec, type Exec } from './db';
import { defaultHarness, validateHarness, harnessInstructions, type Harness } from '../../sandbox/harness';
export { defaultHarness, validateHarness, effectiveTools, harnessInstructions, TOOLS, PLUGINS } from '../../sandbox/harness';
export type { Harness } from '../../sandbox/harness';
export type Definition = { revision: number; name: string; role: string; model: string; harness: Harness; image: string | null; digest: string; harnessDigest: string };
export type Validation = { status: 'passed' | 'failed'; version: number; digest: string; harnessDigest: string; imageId: string; at: number; checks: string[]; tools: string[]; error?: string };
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const harnessHash = (h: unknown) => digest(validateHarness(h));
export function proposalDigest(d: { version: number; model: string; contract: unknown; harness: unknown }) {
 return digest({ version: d.version, model: d.model, contract: d.contract, harness: validateHarness(d.harness) });
}
export function definition(a: { config_revision: number; name: string; role: string; model: string; harness?: Harness; harness_image?: string | null }): Definition {
 const value = { revision: a.config_revision, name: a.name, role: a.role, model: a.model, harness: validateHarness(a.harness ?? defaultHarness()), image: a.harness_image ?? null };
 return { ...value, digest: digest(value), harnessDigest: harnessHash(value.harness) };
}
export function withHarnessPrompt(prompt: string, h: Harness) { return prompt + '\n\n' + harnessInstructions(validateHarness(h)); }
export function saveRevision(a: Parameters<typeof definition>[0] & { id: number }, on: Exec) {
 const d = definition(a);
 return exec(`insert into agent_revisions (agent_id, revision, name, role, model, harness, image) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`, [a.id, d.revision, d.name, d.role, d.model, JSON.stringify(d.harness), d.image], on);
}
