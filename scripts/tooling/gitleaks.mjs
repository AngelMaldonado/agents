import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
export const version = '8.30.1';
const checksums = {
	darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
	darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
	linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
	linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
export async function gitleaks() {
	const platform = `${process.platform}_${process.arch}`;
	if (!checksums[platform]) throw new Error(`Gitleaks: plataforma no soportada ${platform}.`);
	const root = resolve('.tools');
	const bin = join(root, `gitleaks-${version}-${platform}`);
	if (existsSync(bin)) return bin;
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(tmpdir(), 'agents-gitleaks-'));
	try {
		console.log(`Preparando Gitleaks ${version} (checksum fijado, sin sudo)…`);
		const response = await fetch(
			`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`,
			{ signal: AbortSignal.timeout(120000) },
		);
		if (!response.ok) throw new Error(`Gitleaks download HTTP ${response.status}`);
		const data = Buffer.from(await response.arrayBuffer());
		if (createHash('sha256').update(data).digest('hex') !== checksums[platform])
			throw new Error('Checksum de Gitleaks incorrecto.');
		writeFileSync(join(dir, 'archive.tar.gz'), data);
		const result = spawnSync('tar', ['-xzf', join(dir, 'archive.tar.gz'), '-C', dir, 'gitleaks'], { stdio: 'inherit' });
		if (result.status !== 0) throw new Error('No se pudo extraer Gitleaks.');
		// Copy through the destination filesystem before atomic rename.
		const temporary = `${bin}.${process.pid}`;
		writeFileSync(temporary, readFileSync(join(dir, 'gitleaks')));
		chmodSync(temporary, 0o755);
		renameSync(temporary, bin);
		return bin;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
