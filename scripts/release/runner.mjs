import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = (bin, args, options = {}) =>
	execFileSync(bin, args, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
export function assertSource(value) {
	if (!/^agents-release-[a-f0-9]{32}:9418$/.test(value ?? ''))
		throw new Error('Origen Git fuera del runner efímero aprobado.');
	return value;
}
export function checkRunner(config) {
	const docker = (...args) => run('docker', ['--context', config.executorHost, ...args]);
	if (docker('info', '--format', '{{.Name}}') !== config.executorHost)
		throw new Error('El Docker Engine no es reko-3.');
	for (const image of [config.runnerImage, config.toolsImage]) {
		if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Las imágenes auxiliares deben ser inmutables.');
		const [info] = JSON.parse(docker('image', 'inspect', image));
		if (info.Os !== 'linux' || info.Architecture !== 'amd64') throw new Error('Executor distinto de linux/amd64.');
	}
	docker('network', 'inspect', config.runnerNetwork);
}
export function startRunner(config) {
	const name = `agents-release-${randomUUID().replaceAll('-', '')}`;
	const docker = (...args) => run('docker', ['--context', config.executorHost, ...args]);
	// Verify prerequisites before issuing a one-job credential. Never build or install implicitly.
	checkRunner(config);
	const jit = JSON.parse(
		run(
			'gh',
			['api', '--method', 'POST', `repos/${config.repository}/actions/runners/generate-jitconfig`, '--input', '-'],
			{
				input: JSON.stringify({
					name,
					runner_group_id: 1,
					labels: ['self-hosted', 'linux', 'X64', name],
					work_folder: '_work',
				}),
			},
		),
	);
	if (!jit.encoded_jit_config || !jit.runner?.id) throw new Error('GitHub no emitió un runner JIT válido.');
	const dir = mkdtempSync(join(tmpdir(), 'agents-release-jit-'));
	chmodSync(dir, 0o700);
	try {
		const env = join(dir, 'runner.env');
		writeFileSync(env, `ACTIONS_RUNNER_INPUT_JITCONFIG=${jit.encoded_jit_config}\n`, { mode: 0o600 });
		docker(
			'run',
			'-d',
			'--rm',
			'--name',
			name,
			'--network',
			config.runnerNetwork,
			'--cpus',
			'2',
			'--memory',
			'3g',
			'--pids-limit',
			'512',
			'--cap-drop',
			'ALL',
			'--security-opt',
			'no-new-privileges',
			'--label',
			'agents.release.ephemeral=true',
			'--env-file',
			env,
			config.runnerImage,
		);
	} catch {
		try {
			run('gh', ['api', '--method', 'DELETE', `repos/${config.repository}/actions/runners/${jit.runner.id}`]);
		} catch {
			/* credential expires; report below */
		}
		throw new Error(`No arrancó el runner ${name}. Revisa su registro GitHub; no se ha despachado publicación.`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return {
		name,
		source: assertSource(`${name}:9418`),
		stop() {
			let failure = false;
			try {
				docker('rm', '-f', name);
			} catch {
				/* ephemeral runner may already have removed itself */
			}
			try {
				run('gh', ['api', '--method', 'DELETE', `repos/${config.repository}/actions/runners/${jit.runner.id}`]);
			} catch (error) {
				// JIT runners unregister after their one job; distinguish that from an actual API failure.
				try {
					const runners = JSON.parse(run('gh', ['api', `repos/${config.repository}/actions/runners`]));
					failure = runners.runners.some((runner) => runner.id === jit.runner.id);
				} catch {
					failure = true;
				}
				void error;
			}
			if (failure) throw new Error(`No pude confirmar la limpieza del runner ${name}; revísalo antes de reintentar.`);
		},
	};
}
