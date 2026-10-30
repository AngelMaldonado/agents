import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, assertPublicationAllowed } from './config.mjs';
const mode = process.argv[2] ?? 'run';
if (!['run', 'plan'].includes(mode)) throw new Error('Uso: just release [plan]');
mkdirSync('.release', { recursive: true });
const logfile = resolve('.release', `${new Date().toISOString().replaceAll(':', '-')}.log`);
const privateValues = Object.entries(process.env)
	.filter(([k, v]) => /TOKEN|SECRET|PASSWORD|(?:PRIVATE|MASTER|API|KOMODO)_KEY/.test(k) && v && v.length >= 8)
	.map(([, v]) => v);
const clean = (value) => privateValues.reduce((text, v) => text.split(v).join('[REDACTED]'), String(value));
const emit = (text) => {
	const safe = clean(text);
	process.stdout.write(safe);
	appendFileSync(logfile, safe, { mode: 0o600 });
};
async function command(bin, args, capture = false) {
	return new Promise((accept, reject) => {
		const child = spawn(bin, args, { stdio: ['inherit', 'pipe', 'pipe'], timeout: 75 * 60_000 });
		let out = '',
			err = '',
			pendingOut = '',
			pendingErr = '';
		// Buffer complete lines so a secret split across pipe chunks is still redacted.
		const lines = (text) => {
			const end = text.lastIndexOf('\n');
			if (end < 0) return text;
			emit(text.slice(0, end + 1));
			return text.slice(end + 1);
		};
		child.stdout.on('data', (chunk) => {
			out += chunk;
			if (!capture) pendingOut = lines(pendingOut + chunk);
		});
		child.stderr.on('data', (chunk) => {
			err += chunk;
			if (!capture) pendingErr = lines(pendingErr + chunk);
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (!capture) {
				emit(pendingOut);
				emit(pendingErr);
			}
			code === 0
				? accept(out.trim())
				: reject(
						new Error(
							code === null && child.killed
								? `Timeout de ${bin}; revisa operaciones remotas antes de reintentar, pueden seguir activas.`
								: `${bin} terminó con código ${code}. ${capture ? clean(err) : ''}`,
						),
					);
		});
	});
}
let fd, lock;
try {
	emit(`Agents release · target ${config.platform} · registry ${config.registry}\nLogs: ${logfile}\n`);
	if (mode === 'plan') {
		emit(`[PLAN] publicationEnabled=${config.publicationEnabled}; deploymentEnabled=${config.deploymentEnabled}\n`);
		emit(
			'Preflight → calidad → push wip → PR/checks → confirmación merge → workflow main → build/firma/verificación Komodo → GitHub prerelease.\n',
		);
		emit('No se ejecutan comandos remotos, publicación, despliegue, redirección ni migración.\n');
	} else {
		// This gate precedes even git push or PR creation. No env variable can bypass it.
		assertPublicationAllowed();
		const common = await command('git', ['rev-parse', '--git-common-dir'], true);
		lock = resolve(common, 'agents-release.lock');
		fd = openSync(lock, 'wx', 0o600);
		if (await command('git', ['status', '--porcelain'], true))
			throw new Error('Hay cambios sin commit; no se publican ni se corrigen automáticamente.');
		if ((await command('git', ['branch', '--show-current'], true)) !== config.workBranch)
			throw new Error('Ejecuta desde wip.');
		await command('gh', ['auth', 'status']);
		const enabled = await command(
			'gh',
			['variable', 'get', 'AGENTS_RELEASE_ENABLED', '--repo', config.repository],
			true,
		);
		if (enabled !== 'true') throw new Error('Workflow de release deshabilitado en GitHub. No se hará push ni merge.');
		emit('[1/5] Calidad local\n');
		for (const args of [['sanitize', 'history'], ['format', 'check'], ['lint'], ['check']]) await command('just', args);
		emit('[2/5] Publicar wip y abrir/reutilizar PR\n');
		await command('git', ['push', '-u', 'origin', config.workBranch]);
		let prs = JSON.parse(
			await command(
				'gh',
				[
					'pr',
					'list',
					'--repo',
					config.repository,
					'--head',
					config.workBranch,
					'--base',
					config.releaseBranch,
					'--state',
					'open',
					'--json',
					'number,url',
				],
				true,
			),
		);
		if (prs.length === 0) {
			await command('gh', [
				'pr',
				'create',
				'--repo',
				config.repository,
				'--head',
				config.workBranch,
				'--base',
				config.releaseBranch,
				'--fill-first',
			]);
			prs = JSON.parse(
				await command(
					'gh',
					[
						'pr',
						'list',
						'--repo',
						config.repository,
						'--head',
						config.workBranch,
						'--base',
						config.releaseBranch,
						'--state',
						'open',
						'--json',
						'number,url',
					],
					true,
				),
			);
		}
		if (prs.length !== 1) throw new Error('No hay una PR inequívoca para wip → main.');
		const pr = prs[0];
		emit(`${pr.url}\n[3/5] Esperar checks obligatorios\n`);
		await command('gh', [
			'pr',
			'checks',
			String(pr.number),
			'--repo',
			config.repository,
			'--required',
			'--watch',
			'--fail-fast',
		]);
		const head = await command(
			'gh',
			['pr', 'view', String(pr.number), '--repo', config.repository, '--json', 'headRefOid', '--jq', '.headRefOid'],
			true,
		);
		if (!process.stdin.isTTY) throw new Error('Merge requiere confirmación interactiva. No se omiten protecciones.');
		const { createInterface } = await import('node:readline/promises');
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		let answer;
		try {
			answer = await rl.question(`¿Integrar PR #${pr.number} (${head}) y publicar? Escribe PUBLICAR: `);
		} finally {
			rl.close();
		}
		if (answer !== 'PUBLICAR') throw new Error('Cancelado por la persona antes del merge.');
		emit('[4/5] Merge protegido\n');
		await command('gh', [
			'pr',
			'merge',
			String(pr.number),
			'--repo',
			config.repository,
			'--merge',
			'--match-head-commit',
			head,
		]);
		const sha = await command(
			'gh',
			[
				'pr',
				'view',
				String(pr.number),
				'--repo',
				config.repository,
				'--json',
				'mergeCommit',
				'--jq',
				'.mergeCommit.oid',
			],
			true,
		);
		emit(`[5/5] Disparar y seguir release manual del SHA ${sha}\n`);
		await command('gh', [
			'workflow',
			'run',
			'release.yml',
			'--repo',
			config.repository,
			'--ref',
			config.releaseBranch,
			'-f',
			`sha=${sha}`,
		]);
		let run;
		for (let i = 0; i < 30; i++) {
			const runs = JSON.parse(
				await command(
					'gh',
					[
						'run',
						'list',
						'--repo',
						config.repository,
						'--workflow',
						'release.yml',
						'--commit',
						sha,
						'--json',
						'databaseId,url',
					],
					true,
				),
			);
			if (runs.length > 1) throw new Error('Múltiples workflows para el mismo SHA; revisión manual necesaria.');
			if (runs.length === 1) {
				run = runs[0];
				break;
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		if (!run) throw new Error('Merge realizado pero workflow no apareció. No se publica localmente como fallback.');
		emit(`${run.url}\n`);
		try {
			await command('gh', ['run', 'watch', String(run.databaseId), '--repo', config.repository, '--exit-status']);
		} catch (error) {
			await command('gh', ['run', 'view', String(run.databaseId), '--repo', config.repository, '--log-failed']);
			throw error;
		}
		await command('gh', ['run', 'view', String(run.databaseId), '--repo', config.repository, '--log']);
		const jobs = JSON.parse(
			await command('gh', ['run', 'view', String(run.databaseId), '--repo', config.repository, '--json', 'jobs'], true),
		).jobs;
		if (jobs.length !== 1 || jobs[0].conclusion !== 'success')
			throw new Error('El job de publicación no terminó correctamente (posible skip).');
		const resultDir = resolve('.release', `result-${run.databaseId}-${Date.now()}`);
		await command('gh', [
			'run',
			'download',
			String(run.databaseId),
			'--repo',
			config.repository,
			'--name',
			`release-record-${sha}`,
			'--dir',
			resultDir,
		]);
		const outcome = JSON.parse(readFileSync(resolve(resultDir, 'outcome.json'), 'utf8'));
		if (outcome.sha !== sha || !['published', 'unchanged'].includes(outcome.state))
			throw new Error('Resultado de publicación ausente o no coincide con el SHA aprobado.');
		emit(
			outcome.state === 'published'
				? `Publicado v${outcome.version} (${sha}).\n`
				: `Sin cambios publicables (${sha}); no se creó una release.\n`,
		);
		emit('No se ejecutó despliegue ni migración.\n');
	}
} catch (error) {
	emit(
		`\nERROR: ${error.message}\nSe detiene el release. Un merge/artefacto ya publicado no se revierte automáticamente.\n`,
	);
	process.exitCode = 1;
} finally {
	if (fd !== undefined) {
		closeSync(fd);
		rmSync(lock, { force: true });
	}
}
