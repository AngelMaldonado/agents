// Sólo lee la copia restaurada y escribe otra copia temporal; nunca volúmenes vivos.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function safeRelative(value) {
	if (
		typeof value !== 'string' ||
		!value ||
		value.includes('\\') ||
		value.includes('\0') ||
		path.posix.normalize(value) !== value ||
		value.startsWith('/') ||
		value.split('/').some((p) => p === '.' || p === '..' || !p)
	)
		throw new Error('Ruta de datos no admitida');
	return value;
}
export function filteredData(source, destination, plan) {
	if (source !== '/source' || destination !== '/destination') throw new Error('Sólo copias aisladas');
	const paths = new Set(plan.dataPaths.map(safeRelative));
	for (const id of plan.runIds) {
		if (!Number.isSafeInteger(id) || id < 1) throw new Error('Corrida inválida');
		const snapshot = `snapshots/${id}.json`;
		if (fs.existsSync(path.join(source, snapshot))) paths.add(snapshot);
	}
	let copied = 0;
	for (const relative of paths) {
		if (!/^(inbox|runs|designs|snapshots)\//.test(relative)) throw new Error('Categoría desconocida');
		const components = relative.split('/');
		let location = source;
		for (const c of components) {
			location = path.join(location, c);
			if (fs.lstatSync(location).isSymbolicLink()) throw new Error('Symlink en datos; no se sigue');
		}
		const before = fs.statSync(location);
		if (!before.isFile() || before.nlink !== 1) throw new Error('Archivo de datos no regular');
		const target = path.join(destination, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		if (fs.existsSync(target)) throw new Error('Destino ya existente');
		execFileSync('cp', ['--archive', '--no-dereference', '--', location, target], { stdio: 'pipe' });
		const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
		if (hash(location) !== hash(target)) throw new Error('Copia distinta');
		copied++;
	}
	let discovered = 0;
	const walk = (dir) => {
		for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, item.name);
			if (item.isDirectory()) walk(full);
			else discovered++;
		}
	};
	walk(source);
	return {
		filesCopied: copied,
		sourceFiles: discovered,
		orphanedOrExcludedFilesNotCopied: discovered - copied,
		retainedFilesHashVerified: true,
		sourceChanged: false,
	};
}
if (process.env.AGENTS_FILTERED_COPY === 'true') {
	try {
		console.log(
			JSON.stringify(
				filteredData('/source', '/destination', JSON.parse(fs.readFileSync('/plan/data-plan.json', 'utf8'))),
			),
		);
	} catch {
		console.log(JSON.stringify({ ok: false, error: 'Falló copia filtrada; se omiten rutas privadas' }));
		process.exitCode = 1;
	}
}
