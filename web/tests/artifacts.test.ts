import { expect, test } from 'bun:test';
import { artifactUrl, linkedArtifact, csvPreview, isolatedHtml } from '../src/lib/artifacts';
test('known artifact links use stable authenticated routes; external links are not hijacked', () => {
	const names = ['report.md', 'datos.csv'];
	for (const path of [
		'report.md',
		'./report.md',
		'out/report.md',
		'~/work/out/report.md',
		'/home/agent/work/out/report.md',
		'sandbox:/mnt/data/report.md',
		'/api/tasks/7/files/report.md',
	])
		expect(linkedArtifact(path, 7, names)).toBe('report.md');
	for (const path of [
		'https://evil.test/report.md',
		'//evil.test/report.md',
		'javascript:report.md',
		'data:text/html,report.md',
		'../report.md',
		'/api/tasks/8/files/report.md',
		'%ZZ',
		'missing.md',
	])
		expect(linkedArtifact(path, 7, names)).toBeNull();
	expect(artifactUrl(10, 7, 'a b.md')).toBe('#/agent/10/artifact/7/a%20b.md');
});
test('CSV displays quoted commas/newlines/double quotes, BOM and formulas literally', () => {
	expect(
		csvPreview('\uFEFFNombre,Valor\r\n"A, B","dos ""comillas"""\r\n"línea\nnueva",=HYPERLINK("x")\r\n').rows,
	).toEqual([
		['Nombre', 'Valor'],
		['A, B', 'dos "comillas"'],
		['línea\nnueva', '=HYPERLINK("x")'],
	]);
	expect(csvPreview('a,b,c\n1,2,3\n4,5,6', 2, 2)).toEqual({
		rows: [
			['a', 'b'],
			['1', '2'],
		],
		limited: true,
		malformed: false,
	});
	expect(csvPreview('a,b\n"unfinished')).toMatchObject({ malformed: true });
});
test('isolated HTML document puts restrictive CSP ahead of sanitized markup', () => {
	const html = isolatedHtml('<h1>Static</h1>');
	expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<h1>'));
	expect(html).toContain("script-src 'none'");
	expect(html).toContain("default-src 'none'");
	expect(html).not.toContain('allow-same-origin');
});
