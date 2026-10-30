import { mkdirSync, writeFileSync } from 'node:fs';
import { config, assertPublicationAllowed } from './config.mjs';
import { Komodo } from './komodo.mjs';
import { prepareArtifacts } from './artifacts.mjs';
import { assertVersion } from './version.mjs';
export async function verifyConditions() {
	assertPublicationAllowed();
}
export async function verifyRelease(_options, context) {
	assertVersion(context.nextRelease.version);
}
export async function prepare(_options, context) {
	const client = new Komodo({
		url: config.komodo.url,
		key: process.env.AGENTS_RELEASE_KOMODO_KEY,
		secret: process.env.AGENTS_RELEASE_KOMODO_SECRET,
	});
	const manifest = await prepareArtifacts(client, context.nextRelease.version, context.nextRelease.gitHead);
	mkdirSync('.release', { recursive: true });
	writeFileSync('.release/release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
}
