import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateHarness, runtimeToolNames, mcpPrefix } from './harness.ts';
export const harnessDigest = (h) =>
	createHash('sha256')
		.update(JSON.stringify(validateHarness(h)))
		.digest('hex');
/**
 * granted: MCP servers the owner granted to the agent (#24), already resolved by the backend (their
 * secrets replaced by placeholders the egress proxy swaps). They join the approved ones in mcp.json
 * and in --tools, but not the digest: a harness server with the same name wins.
 */
export function prepareHarness(value, dir, granted = [], selfMaintenance = true) {
	const h = validateHarness(value);
	mkdirSync(dir, { recursive: true });
	const skillArgs = [];
	for (const skill of h.skills) {
		const folder = join(dir, 'skills', skill.name);
		mkdirSync(folder, { recursive: true });
		const path = join(folder, 'SKILL.md');
		writeFileSync(
			path,
			`---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`,
			{ mode: 0o400 },
		);
		skillArgs.push('--skill', path);
	}
	// Approved MCP servers plus granted ones, declared to the model (direct) and limited by --tools to their prefix.
	const approved = h.mcp ?? [];
	const extra = (Array.isArray(granted) ? granted : []).filter(
		(g) => g && typeof g.name === 'string' && !approved.some((s) => s.name === g.name),
	);
	const mcp = [...approved, ...extra];
	const pairs = (list) => Object.fromEntries(list.map((p) => [p.name, p.value]));
	const mcpConfig = mcp.length
		? {
				mcpServers: Object.fromEntries(
					mcp.map((s) => [
						s.name,
						s.transport === 'http'
							? {
									url: s.url,
									...(s.headers.length ? { headers: pairs(s.headers) } : {}),
									exposure: 'direct',
									description: s.description,
								}
							: {
									command: s.command,
									args: s.args,
									...(s.env.length ? { env: pairs(s.env) } : {}),
									exposure: 'direct',
									description: s.description,
								},
					]),
				),
			}
		: null;
	// CLI selection is applied separately from session_start activation: include the platform tool
	// explicitly, but never advertise it to a delegated child process.
	const tools = [
		...runtimeToolNames(h),
		...(selfMaintenance
			? [
					'self_maintenance',
					'job_done',
					'job_goal',
					'task_plan',
					'task_update',
					'task_ask',
					'task_list',
					'mem_save',
					'mem_search',
					'mem_forget',
				]
			: []),
		...mcp.map((s) => `${mcpPrefix(s.name)}*`),
	];
	return {
		harness: h,
		digest: harnessDigest(h),
		env: { AGENTS_HARNESS: JSON.stringify(h), AGENTS_GRANTED_MCP: JSON.stringify(extra.map((g) => g.name)) },
		mcpConfig,
		// -ne keeps every discovered extension out (the agent can write to pi's directory in its volume);
		// MCP is one of pi's built-in extensions, so it is loaded by name when the harness has servers.
		args: [
			'-ne',
			'-ns',
			'-nc',
			'-np',
			'--no-themes',
			...(mcp.length ? ['-e', 'builtin:mcp'] : ['--no-mcp']),
			'--no-approve',
			'-e',
			'/opt/agents/harness-extension.ts',
			'--tools',
			tools.join(','),
			...skillArgs,
		],
	};
}
