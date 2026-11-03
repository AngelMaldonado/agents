import { expect, test } from 'bun:test';
import { nextBeta, releasable } from './version.mjs';

test('the next beta raises the patch of the latest beta tag', () => {
	expect(nextBeta([])).toBeNull();
	expect(nextBeta(['v0.0.1-beta'])).toEqual({ latest: 'v0.0.1-beta', next: '0.0.2-beta' });
	expect(nextBeta(['v0.0.2-beta', 'v0.0.10-beta', 'v0.0.9-beta'])).toEqual({
		latest: 'v0.0.10-beta',
		next: '0.0.11-beta',
	});
	// A numbered prerelease counts as its own patch; non-beta or foreign tags are ignored.
	expect(nextBeta(['v0.0.1-beta', 'v0.0.1-beta.1', 'v1.0.0', 'deploy-x'])?.next).toBe('0.0.2-beta');
	expect(nextBeta(['v0.1.4-beta'])?.next).toBe('0.1.5-beta');
});

test('only releasing commit types publish', () => {
	expect(releasable([])).toBe(false);
	expect(releasable(['docs: readme', 'chore: tidy', 'test(web): more', 'Merge branch wip'])).toBe(false);
	expect(releasable(['chore: tidy', 'fix(deploy): normalize LF'])).toBe(true);
	expect(releasable(['feat!: new api'])).toBe(true);
	expect(releasable(['chore(release): pin tools'])).toBe(true);
	expect(releasable(['chore: drop old flag\n\nBREAKING CHANGE: the flag is gone'])).toBe(true);
	expect(releasable(['docs: mention fix: in prose'])).toBe(false);
});

test('changelog groups what a release brings by kind, without tests, docs or chores', async () => {
	const { changelog } = await import('./version.mjs');
	expect(
		changelog([
			'feat: WhatsApp groups per person',
			'test(e2e): an agent view no longer lists numbers',
			'fix(release): wait for checks',
			'feat(web): aliases',
			'docs: readme',
			'build: pin bun',
		]),
	).toBe(
		'### Nuevo\n\n- WhatsApp groups per person (`feat`)\n- aliases (`feat(web)`)\n\n### Arreglos\n\n- wait for checks (`fix(release)`)\n\n### Otros cambios\n\n- pin bun (`build`)',
	);
	expect(changelog(['docs: only docs'])).toBe('');
});
