// Expected migration set shipped with this commit, NOT the schema of any live database.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
export function schemaInfo() {
	const base = new URL('../../server/migrations/', import.meta.url);
	const files = readdirSync(base)
		.filter((name) => /^\d+_.+\.sql$/.test(name))
		.sort();
	if (!files.length) throw new Error('No hay migraciones del artefacto para registrar.');
	const hash = createHash('sha256');
	for (const name of files) {
		hash.update(name + '\0');
		hash.update(readFileSync(new URL(name, base)));
		hash.update('\0');
	}
	return { files, sha256: hash.digest('hex') };
}
