import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gitleaks } from './gitleaks.mjs';
const mode = process.argv[2] ?? 'history';
if (!['staged', 'history'].includes(mode)) throw new Error('sanitize: staged | history');
const git = (...args) => {
	const p = spawnSync('git', args, { encoding: 'utf8' });
	if (p.status !== 0) throw new Error('No se pudo leer el índice Git.');
	return p.stdout;
};
const paths = (
	mode === 'staged' ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z') : git('ls-files', '-z')
)
	.split('\0')
	.filter(Boolean);
for (const path of paths) {
	if (/(^|\/)(\.env(?:\..*)?|creds\.toml|cosign\.key|id_rsa|id_ed25519)$/.test(path) && !/\.example$/.test(path))
		throw new Error(`Archivo sensible no permitido en Git: ${path}`);
	let contents;
	try {
		contents = mode === 'staged' ? git('show', `:${path}`) : readFileSync(path, 'utf8');
	} catch {
		continue;
	}
	if (/^(?:<{7} |={7}$|>{7} )/m.test(contents)) throw new Error(`Conflicto de merge sin resolver: ${path}`);
}
const p = spawnSync(
	await gitleaks(),
	[
		'git',
		'--redact=100',
		'--no-banner',
		'--config',
		'.gitleaks.toml',
		...(mode === 'staged' ? ['--pre-commit', '--staged'] : ['--log-opts=--all']),
		'.',
	],
	{ stdio: 'inherit' },
);
if (p.error) throw p.error;
process.exit(p.status ?? 1);
