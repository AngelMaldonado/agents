import { execFileSync } from 'node:child_process';
const title = process.env.PR_TITLE ?? '';
const conventional = /^(feat|fix|perf|refactor|build|ci|docs|test|style|chore|revert)(\([a-z0-9/-]+\))?!?: .+/;
if (!conventional.test(title))
	throw new Error('El título de la PR debe ser Conventional Commit, por ejemplo: feat: crear agentes.');
const base = process.env.PR_BASE_SHA,
	head = process.env.PR_HEAD_SHA;
if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? ''))
	throw new Error('Faltan los SHAs de la PR para validar sus commits.');
const subjects = execFileSync('git', ['log', '--no-merges', '--format=%s', `${base}..${head}`], { encoding: 'utf8' })
	.trim()
	.split('\n')
	.filter(Boolean);
if (!subjects.length || subjects.some((subject) => !conventional.test(subject)))
	throw new Error(
		'Todos los commits nuevos no-merge de la PR deben usar Conventional Commits. Corrige antes de integrar.',
	);
