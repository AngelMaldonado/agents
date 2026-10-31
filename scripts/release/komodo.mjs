export function updateId(value) {
	const id = value?.id ?? value?._id?.$oid ?? value?._id;
	if (typeof id !== 'string' || !id) throw new Error('Komodo no devolvió un ID de ejecución.');
	return id;
}
export class Komodo {
	constructor({
		url,
		key,
		secret,
		fetcher = fetch,
		emit = console.log,
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		now = Date.now,
	}) {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))
			throw new Error('Komodo requiere HTTPS.');
		if (!key || !secret) throw new Error('Faltan AGENTS_RELEASE_KOMODO_KEY/SECRET (nunca se pasan por argumentos).');
		Object.assign(this, { url: parsed.href.replace(/\/$/, ''), key, secret, fetcher, emit, sleep, now });
	}
	redact(text) {
		return String(text).split(this.key).join('[REDACTED]').split(this.secret).join('[REDACTED]');
	}
	async request(category, type, params = {}) {
		const res = await this.fetcher(`${this.url}/${category}`, {
			method: 'POST',
			signal: AbortSignal.timeout(30000),
			headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.key, 'X-Api-Secret': this.secret },
			body: JSON.stringify({ type, params }),
		});
		if (!res.ok) throw new Error(`Komodo ${type}: HTTP ${res.status}. Verifica conectividad y permisos del recurso.`);
		const data = await res.json();
		if (data?.error) throw new Error(this.redact(`Komodo ${type}: ${data.error}`));
		return data;
	}
	async execute(type, params, { timeoutMs = 1800000 } = {}) {
		let update = await this.request('execute', type, params);
		const id = updateId(update),
			deadline = this.now() + timeoutMs;
		this.emit(`Komodo ${type}: ejecución ${id}`);
		const seen = new Map();
		for (;;) {
			for (const [i, log] of (update.logs ?? []).entries()) {
				const text = this.redact(`[${log.stage ?? type}]\n${log.stdout ?? ''}${log.stderr ?? ''}`);
				if (seen.get(i) !== text) {
					this.emit(text);
					seen.set(i, text);
				}
			}
			if (update.status === 'Complete') {
				if (update.success !== true)
					throw new Error(`Komodo ${type} falló. Ejecución ${id}; no se ejecutan pasos posteriores.`);
				return update;
			}
			if (!['Queued', 'InProgress'].includes(update.status))
				throw new Error(`Estado de Komodo no reconocido: ${update.status}`);
			if (this.now() >= deadline)
				throw new Error(`Timeout de ${type}. Operación remota ${id} puede seguir activa; no reintentes sin revisarla.`);
			await this.sleep(2000);
			update = await this.request('read', 'GetUpdate', { id });
		}
	}
}
