const token = process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
if (!token || !repo || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Falta identidad del workflow.');
const until = Date.now() + 35 * 60_000;
let passed = false;
while (Date.now() < until) {
	const response = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
		signal: AbortSignal.timeout(30000),
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
	});
	if (!response.ok) throw new Error(`No se pueden verificar checks: HTTP ${response.status}.`);
	const { check_runs: checks } = await response.json();
	const check = checks
		.filter((c) => c.name === 'Required checks' && c.app?.slug === 'github-actions')
		.sort((a, b) => b.id - a.id)[0];
	if (check?.status === 'completed') {
		if (check.conclusion !== 'success')
			throw new Error(`Checks del SHA integrado: ${check.conclusion}. No se publica.`);
		passed = true;
		break;
	}
	console.log(`Esperando Required checks del SHA ${sha}…`);
	await new Promise((r) => setTimeout(r, 10000));
}
if (!passed) throw new Error('Timeout esperando checks del SHA integrado.');
