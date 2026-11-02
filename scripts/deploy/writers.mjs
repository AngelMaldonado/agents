// Sólo metadatos del host; detectar FDs y mmap compartidos escribibles de los orígenes montados RO.
import fs from 'node:fs';
const targets = new Set();
let sourceBytes = 0;
let minimumFreeBytes = Number.MAX_SAFE_INTEGER;
const identity = (s) => {
	const d = s.dev;
	const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
	const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
	return `${major}:${minor}:${s.ino}`;
};
const walk = (path) => {
	for (const name of fs.readdirSync(path)) {
		const p = path + '/' + name;
		const s = fs.lstatSync(p, { bigint: true });
		if (s.isDirectory()) walk(p);
		else if (s.isFile()) {
			targets.add(identity(s));
			sourceBytes += Number(s.size);
		}
	}
};
for (const dir of fs.readdirSync('/sources')) {
	const path = '/sources/' + dir;
	const space = fs.statfsSync(path, { bigint: true });
	minimumFreeBytes = Math.min(minimumFreeBytes, Number(space.bavail * space.bsize));
	walk(path);
}
let writers = 0,
	inaccessible = 0;
for (const pid of fs.readdirSync('/hostproc').filter((n) => /^\d+$/.test(n))) {
	try {
		for (const fd of fs.readdirSync(`/hostproc/${pid}/fd`)) {
			try {
				const stat = fs.statSync(`/hostproc/${pid}/fd/${fd}`, { bigint: true });
				if (!targets.has(identity(stat))) continue;
				const info = fs.readFileSync(`/hostproc/${pid}/fdinfo/${fd}`, 'utf8');
				const flags = info.match(/^flags:\s+([0-7]+)$/m);
				if (!flags) throw Error('FD sin flags');
				if ((Number.parseInt(flags[1], 8) & 3) !== 0) writers++;
			} catch (e) {
				if (!['ENOENT', 'ESRCH', 'EBADF'].includes(e.code)) inaccessible++;
			}
		}
		for (const line of fs.readFileSync(`/hostproc/${pid}/maps`, 'utf8').split('\n')) {
			const parts = line.split(/\s+/);
			if (!/^rw.s$/.test(parts[1] ?? '') || !parts[4] || parts[4] === '0') continue;
			const [major, minor] = parts[3].split(':').map((v) => BigInt('0x' + v));
			if (targets.has(`${major}:${minor}:${BigInt(parts[4])}`)) writers++;
		}
	} catch (e) {
		if (!['ENOENT', 'ESRCH'].includes(e.code)) inaccessible++;
	}
}
console.log(
	JSON.stringify({
		writers,
		inaccessible,
		regularFiles: targets.size,
		sourceBytes,
		minimumFreeBytes,
		fileContentsRead: false,
	}),
);
