const title = process.env.PR_TITLE ?? '';
if (!/^(feat|fix|perf|refactor|build|ci|docs|test|style|chore|revert)(\([a-z0-9/-]+\))?!?: .+/.test(title)) {
	throw new Error('El título de la PR debe ser Conventional Commit, por ejemplo: feat: crear agentes.');
}
