// Fixed, unprivileged installer. Never accepts a shell command from the model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
async function size(path) {
	const s = await lstat(path);
	if (s.isSymbolicLink()) return s.size;
	if (!s.isDirectory()) return s.size;
	let n = 0;
	for (const name of await readdir(path)) n += await size(join(path, name));
	return n;
}
export async function installAuthorized(plan, { work, env, run = exec }) {
	if (!/^[a-f0-9-]{36}$/.test(plan.id) || !Array.isArray(plan.packages) || !plan.packages.length)
		throw new Error('Invalid installation plan');
	const root = join(work, 'tools', '.agents-installs'),
		dest = join(root, plan.id),
		staging = dest + '.partial';
	const fingerprint = createHash('sha256').update(JSON.stringify(plan.packages)).digest('hex');
	try {
		const old = JSON.parse(await readFile(join(dest, 'installed.json'), 'utf8'));
		if (old.fingerprint === fingerprint) return { ok: true, path: dest, reused: true };
	} catch {}
	await mkdir(root, { recursive: true });
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging);
	const maxBytes = (plan.automatic ? 50 : 250) * 1024 * 1024,
		timeout = plan.automatic ? 120000 : 300000;
	// Do not pass granted tokens or the LLM gateway key to package installers.
	// npm rejects loading the same file as both its user and global configuration.
	const userConfig = join(staging, '.npm-user.conf'),
		globalConfig = join(staging, '.npm-global.conf');
	await writeFile(userConfig, '', { mode: 0o600 });
	await writeFile(globalConfig, '', { mode: 0o600 });
	const clean = {
		HOME: env.HOME,
		PATH: env.PATH,
		LANG: 'C.UTF-8',
		npm_config_userconfig: userConfig,
		npm_config_globalconfig: globalConfig,
		UV_NO_CONFIG: '1',
	};
	const started = Date.now();
	const command = async (bin, args) => {
		await run(bin, args, {
			cwd: staging,
			env: clean,
			timeout: Math.max(1, timeout - (Date.now() - started)),
			maxBuffer: 1024 * 1024,
		});
		if ((await size(staging)) > maxBytes) throw new Error('Installation disk budget exceeded');
	};
	try {
		const npm = plan.packages.filter((p) => p.kind === 'npm'),
			uv = plan.packages.filter((p) => p.kind === 'uv');
		if (npm.length) {
			await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true }));
			await command('npm', [
				'install',
				'--prefix',
				staging,
				'--ignore-scripts',
				'--no-audit',
				'--no-fund',
				'--registry=https://registry.npmjs.org',
				'--save-exact',
				...npm.map((p) => p.spec),
			]);
			for (const p of npm) {
				const split = p.spec.lastIndexOf('@'),
					name = p.spec.slice(0, split),
					version = p.spec.slice(split + 1);
				const meta = JSON.parse(await readFile(join(staging, 'node_modules', name, 'package.json'), 'utf8'));
				if (meta.version !== version) throw new Error('Installed version mismatch');
			}
		}
		if (uv.length) {
			// Relative entrypoints must survive the atomic staging rename.
			await command('uv', ['venv', '--relocatable', join(staging, 'venv')]);
			await command('uv', [
				'pip',
				'install',
				'--python',
				join(staging, 'venv', 'bin', 'python'),
				'--only-binary',
				':all:',
				'--no-deps',
				'--index-url',
				'https://pypi.org/simple',
				...uv.map((p) => p.spec),
			]);
			await command('uv', ['pip', 'check', '--python', join(staging, 'venv', 'bin', 'python')]);
		}
		for (const p of plan.packages.filter((p) => p.kind === 'binary')) {
			const response = await fetch(p.spec, {
				signal: AbortSignal.timeout(Math.max(1, timeout - (Date.now() - started))),
			});
			if (!response.ok || !response.body) throw new Error('Download failed');
			const chunks = [];
			let bytes = 0;
			for await (const chunk of response.body) {
				bytes += chunk.length;
				if (bytes > maxBytes) throw new Error('Download too large');
				chunks.push(chunk);
			}
			const data = Buffer.concat(chunks);
			if (createHash('sha256').update(data).digest('hex') !== p.sha256) throw new Error('Checksum mismatch');
			await mkdir(join(staging, 'bin'), { recursive: true });
			await writeFile(join(staging, 'bin', p.name), data, { mode: 0o755 });
		}
		if ((await size(staging)) > maxBytes) throw new Error('Installation too large');
		await writeFile(join(staging, 'installed.json'), JSON.stringify({ fingerprint, packages: plan.packages }));
		await rm(dest, { recursive: true, force: true });
		await rename(staging, dest);
		return {
			ok: true,
			path: dest,
			bins: [join(dest, 'node_modules', '.bin'), join(dest, 'venv', 'bin'), join(dest, 'bin')],
		};
	} catch {
		await rm(staging, { recursive: true, force: true });
		return {
			ok: false,
			error:
				'La instalación falló, requiere dependencias adicionales o superó los límites. No se ejecutaron scripts ni se cambió el runtime de plataforma.',
		};
	}
}
