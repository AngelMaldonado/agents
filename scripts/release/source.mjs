// Temporary Git dumb-HTTP origin, reachable ONLY inside Komodo's private Docker network.
// A fresh bare clone never copies checkout's credential configuration or environment.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, statSync, createReadStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'agents-git-'));
execFileSync('git', ['clone', '--bare', '--no-hardlinks', '.', join(root, 'agents.git')], { stdio: 'ignore' });
const localConfig = execFileSync('git', ['--git-dir', join(root, 'agents.git'), 'config', '--local', '--list'], {
	encoding: 'utf8',
});
if (/credential|extraheader|includeif/i.test(localConfig))
	throw new Error('El snapshot no debe contener configuración de autenticación.');
const sourceUrl = execFileSync('git', ['--git-dir', join(root, 'agents.git'), 'config', '--get', 'remote.origin.url'], {
	encoding: 'utf8',
}).trim();
if (resolve(sourceUrl) !== process.cwd()) throw new Error('Origen del snapshot inesperado.');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
execFileSync('git', ['--git-dir', join(root, 'agents.git'), 'update-ref', 'refs/heads/approved', sha]);
execFileSync('git', ['--git-dir', join(root, 'agents.git'), 'update-server-info'], { stdio: 'ignore' });
const server = createServer((request, response) => {
	let path;
	try {
		path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://source').pathname)}`);
	} catch {
		response.writeHead(400).end();
		return;
	}
	if (!['GET', 'HEAD'].includes(request.method) || !path.startsWith(root + sep)) {
		response.writeHead(403).end();
		return;
	}
	try {
		const info = statSync(path);
		if (!info.isFile()) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { 'content-length': info.size, 'content-type': 'application/octet-stream' });
		if (request.method === 'HEAD') response.end();
		else
			createReadStream(path)
				.on('error', () => response.destroy())
				.pipe(response);
	} catch {
		response.writeHead(404).end();
	}
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(9418, '0.0.0.0', () => console.log('Snapshot Git aprobado disponible sólo en la red privada.'));
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => {
		server.close();
		rmSync(root, { recursive: true, force: true });
		process.exit(0);
	});
