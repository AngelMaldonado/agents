import { spawn } from 'node:child_process';
import {
	mkdirSync,
	openSync,
	closeSync,
	rmSync,
	appendFileSync,
	mkdtempSync,
	symlinkSync,
	existsSync,
	cpSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { config, assertPublicationAllowed } from './config.mjs';
const mode = process.argv[2] ?? 'run';
if (!['run', 'plan'].includes(mode)) throw new Error('Uso: just release [plan]');
const root = process.cwd();
mkdirSync('.release', { recursive: true });
const logfile = resolve('.release', `${new Date().toISOString().replaceAll(':', '-')}.log`);
const privateValues = Object.entries(process.env)
	.filter(([k, v]) => /TOKEN|SECRET|PASSWORD|(?:PRIVATE|MASTER|API|KOMODO)_KEY/.test(k) && v && v.length >= 8)
	.map(([, v]) => v);
const clean = (value) => privateValues.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
const emit = (text) => {
	const safe = clean(text);
	process.stdout.write(safe);
	appendFileSync(logfile, safe, { mode: 0o600 });
};
async function command(bin, args, capture = false, options = {}) {
	return new Promise((accept, reject) => {
		const child = spawn(bin, args, { stdio: ['inherit', 'pipe', 'pipe'], timeout: 75 * 60_000, ...options });
		let out = '',
			err = '',
			pendingOut = '',
			pendingErr = '';
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
							clean(
								`${bin}: ${code === null && child.killed ? 'timeout; una operación remota puede continuar' : `código ${code}`}. ${capture ? err : ''}`,
							),
						),
					);
		});
	});
}
let fd, lock, work;
try {
	emit(`Agents release · ${config.platform} · logs ${logfile}\n`);
	if (mode === 'plan') {
		emit(
			`[PLAN] publicationEnabled=${config.publicationEnabled}; deploymentEnabled=${config.deploymentEnabled}\nCalidad → PR/checks → merge sin prompt → CI main → dos Repos Komodo (build/sign/verify) → GitHub prerelease.\nNo se ejecutan operaciones remotas. No hay runner ni servidor Git temporal.\n`,
		);
	} else {
		assertPublicationAllowed();
		if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_INDEX_FILE)
			throw new Error('No ejecutes release desde un hook ni con el repositorio Git redirigido.');
		lock = resolve(await command('git', ['rev-parse', '--git-common-dir'], true), 'agents-release.lock');
		fd = openSync(lock, 'wx', 0o600);
		if (await command('git', ['status', '--porcelain'], true))
			throw new Error('Hay cambios sin commit; no se corrigen ni confirman automáticamente.');
		if ((await command('git', ['branch', '--show-current'], true)) !== config.workBranch)
			throw new Error('Ejecuta desde wip.');
		await command('gh', ['auth', 'status']);
		if (
			(await command('gh', ['variable', 'get', 'AGENTS_RELEASE_ENABLED', '--repo', config.repository], true)) !== 'true'
		)
			throw new Error('Publicación bloqueada en GitHub.');
		// Validate credentials before even pushing/merging; only the scoped API credential leaves 1Password.
		const item = JSON.parse(
			await command(
				'op',
				['item', 'get', config.komodo.credentialsItem, '--vault', config.komodo.credentialsVault, '--format=json'],
				true,
			),
		);
		const fields = Object.fromEntries(item.fields.map((field) => [field.label, field.value]));
		if (!fields.key || !fields.secret) throw new Error('Faltan key/secret de API Komodo en 1Password.');
		privateValues.push(fields.key, fields.secret);
		const env = { ...process.env, AGENTS_RELEASE_KOMODO_KEY: fields.key, AGENTS_RELEASE_KOMODO_SECRET: fields.secret };
		// No sandbox image builds, signing keys, SSH sessions or custom runners on this Mac.
		for (const args of [['sanitize', 'history'], ['format', 'check'], ['lint'], ['check']]) await command('just', args);
		await command('git', ['push', '-u', 'origin', config.workBranch]);
		const list = () =>
			command(
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
			).then(JSON.parse);
		let prs = await list();
		if (!prs.length) {
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
			prs = await list();
		}
		if (prs.length !== 1) throw new Error('No hay una PR inequívoca.');
		const pr = prs[0];
		emit(`PR ${pr.url}\n`);
		// Wait for the checks main requires, ourselves: `gh pr checks --watch --required` exits with «no
		// required checks reported» while a required job does not exist yet (Required checks has
		// `needs: [quality, sandbox]`, so GitHub registers it only when those finish).
		const required = (
			await command(
				'gh',
				[
					'api',
					`repos/${config.repository}/branches/${config.releaseBranch}/protection/required_status_checks`,
					'--jq',
					'.contexts[]',
				],
				true,
			)
		)
			.split('\n')
			.filter(Boolean);
		if (!required.length) throw new Error(`${config.releaseBranch} no exige checks; no se integra sin ellos.`);
		const deadline = Date.now() + 60 * 60_000;
		let last = '';
		for (;;) {
			const rollup = JSON.parse(
				await command(
					'gh',
					['pr', 'view', String(pr.number), '--repo', config.repository, '--json', 'statusCheckRollup'],
					true,
				),
			).statusCheckRollup;
			// Check runs carry name/status/conclusion; commit statuses carry context/state.
			const checks = rollup.map((c) => ({
				name: c.name ?? c.context,
				done: c.status ? c.status === 'COMPLETED' : c.state !== 'PENDING' && c.state !== 'EXPECTED',
				ok: ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion ?? c.state),
				success: (c.conclusion ?? c.state) === 'SUCCESS',
			}));
			const failed = checks.filter((c) => c.done && !c.ok).map((c) => c.name);
			if (failed.length) throw new Error(`Checks fallidos en la PR: ${failed.join(', ')}.`);
			// A required check counts only as SUCCESS: a skipped one must not let the merge through.
			const passed = required.filter((name) => checks.some((c) => c.name === name && c.done && c.success));
			const summary = checks.map((c) => `${c.name}: ${c.done ? 'ok' : 'en curso'}`).join(' · ') || 'sin checks aún';
			if (summary !== last) emit(`Checks · ${summary}\n`);
			last = summary;
			if (passed.length === required.length) break;
			if (Date.now() > deadline)
				throw new Error(`Los checks requeridos (${required.join(', ')}) no terminaron en 60 minutos.`);
			await new Promise((done) => setTimeout(done, 15000));
		}
		const head = await command(
			'gh',
			['pr', 'view', String(pr.number), '--repo', config.repository, '--json', 'headRefOid', '--jq', '.headRefOid'],
			true,
		);
		// Invoking just release is the authorization. There is deliberately no interactive confirmation.
		emit(`Merge protegido del SHA ${head}; sin prompt interactivo.\n`);
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
		if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('SHA integrado inválido.');
		const token = await command('gh', ['auth', 'token'], true);
		privateValues.push(token);
		Object.assign(env, {
			GH_TOKEN: token,
			GITHUB_TOKEN: token,
			GITHUB_REPOSITORY: config.repository,
			GITHUB_SHA: sha,
			AGENTS_RELEASE_APPROVED_SHA: sha,
		});
		await command('bun', ['scripts/ci/wait-checks.mjs'], false, { env });
		work = mkdtempSync(resolve(tmpdir(), 'agents-publish-'));
		await command('git', ['clone', '--no-hardlinks', '--no-checkout', root, work]);
		const git = (args) => command('git', args, false, { cwd: work });
		await git(['remote', 'set-url', 'origin', `https://github.com/${config.repository}.git`]);
		await git(['fetch', 'origin', config.releaseBranch, '--tags']);
		if (await command('git', ['ls-remote', 'origin', 'refs/notes/semantic-release'], true, { cwd: work }))
			await git(['fetch', 'origin', 'refs/notes/semantic-release:refs/notes/semantic-release']);
		await git(['checkout', '-B', config.releaseBranch, sha]);
		symlinkSync(resolve(root, 'node_modules'), resolve(work, 'node_modules'), 'dir');
		await command('node', [resolve(work, 'scripts/release/publish.mjs')], false, { cwd: work, env });
	}
} catch (error) {
	emit(
		`ERROR: ${error.message}\nSe detiene. Merge/artefactos publicados no se revierten. Revisa GitHub y los IDs Komodo antes de reintentar.\n`,
	);
	process.exitCode = 1;
} finally {
	if (work) {
		const records = resolve(work, '.release');
		if (existsSync(records)) {
			const target = resolve(root, '.release', `result-${Date.now()}`);
			cpSync(records, target, { recursive: true });
			emit(`Registros: ${target}\n`);
		}
		rmSync(work, { recursive: true, force: true });
	}
	if (fd !== undefined) {
		closeSync(fd);
		rmSync(lock, { force: true });
	}
}
