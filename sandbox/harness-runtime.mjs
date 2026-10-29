import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHarness, runtimeToolNames } from './harness.ts';
export const harnessDigest = h => createHash('sha256').update(JSON.stringify(validateHarness(h))).digest('hex');
export function prepareHarness(value, dir) {
 const h = validateHarness(value);
 mkdirSync(dir, { recursive: true });
 const skillArgs = [];
 for (const skill of h.skills) {
  const folder = join(dir, 'skills', skill.name);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'SKILL.md');
  writeFileSync(path, `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`, { mode: 0o400 });
  skillArgs.push('--skill', path);
 }
 return { harness: h, digest: harnessDigest(h), env: { AGENTS_HARNESS: JSON.stringify(h) },
  args: ['-ne', '-ns', '-nc', '-np', '--no-themes', '--no-mcp', '--no-approve', '-e', '/opt/agents/harness-extension.ts', '--tools', runtimeToolNames(h).join(','), ...skillArgs] };
}
