import type { Harness, Install } from '../sandbox/harness';

export type Finding = {
	code: string;
	level: 'error' | 'warning' | 'info';
	summary: string;
	fields: string[];
	suggestion: string;
};
export type Diagnosis = {
	revision: number;
	at: number;
	configuration: { role: string; model: string; harness: Harness };
	findings: Finding[];
	accesses: {
		kind: 'key' | 'mcp';
		id: number;
		name: string;
		granted: boolean;
		fields: string[];
		usedBy: { id: number; name: string }[];
	}[];
	runtime?: { at: number; toolsOk: boolean; mcp: { name: string; ok: boolean | null }[]; undelivered: string[] };
};
export type RepairAction =
	| { kind: 'configuration'; role: string; harness: Harness }
	| { kind: 'grant_key' | 'grant_mcp'; accessId: number; name: string; fingerprint: string }
	| { kind: 'install'; packages: Install[] };
export type Repair = {
	id: string;
	code: string;
	agent_id: number;
	person_id: number;
	run_id: number;
	conversation_id: number;
	revision: number;
	status: 'pending' | 'approved' | 'running' | 'done' | 'failed' | 'rejected' | 'expired';
	reason: string;
	action: RepairAction;
	before: { role: string; harness: Harness };
	automatic: boolean;
	policy: string;
	result: string | null;
	created_at: number;
	expires_at: number;
	updated_at: number;
};
export const REPAIR_LABEL: Record<Repair['status'], string> = {
	pending: 'Esperando autorización',
	approved: 'Autorizada · esperando computadora libre',
	running: 'Comprobando y reparando',
	done: 'Arreglo aplicado · comprobaciones técnicas completadas',
	failed: 'No se pudo reparar',
	rejected: 'Rechazada',
	expired: 'Propuesta caducada',
};
export const repairPending = (r: Pick<Repair, 'status'>) => ['pending', 'approved', 'running'].includes(r.status);

// Conservative automatic lane, not a malware detector. Unknown packages always require the owner.
// No lifecycle scripts, source builds, system packages or platform-runtime replacements in either lane.
const SMALL_NPM = new Set(['csv-parse', 'csv-stringify', 'papaparse', 'yaml', 'semver']);
const SMALL_UV = new Set(['pypdf', 'packaging', 'python-dateutil']);
export function installPolicy(packages: Install[]) {
	const automatic =
		packages.length <= 3 &&
		packages.every((p) => {
			if (p.kind === 'npm') return SMALL_NPM.has(p.spec.replace(/@[^@]+$/, ''));
			if (p.kind === 'uv') return SMALL_UV.has(p.spec.split('==')[0].toLowerCase());
			return false;
		});
	return {
		automatic,
		policy: automatic
			? 'Dependencias locales de la lista automática; sin scripts de instalación ni compilaciones. Límite de ejecución de 120 s; se rechaza el resultado si supera 50 MiB instalados; mismas credenciales y permisos del sandbox.'
			: 'Paquetes fuera de la lista automática, binarios o lote mayor: requiere autorización. Instalación local, sin scripts ni compilaciones; límite de ejecución de 300 s; se rechaza el resultado si supera 250 MiB instalados. Autorizar no concede root ni permisos nuevos.',
	};
}
export function repairText(r: Repair) {
	const change =
		r.action.kind === 'configuration'
			? `Contrato propuesto:\n${r.action.role}\n\nHarness propuesto:\n${JSON.stringify(r.action.harness)}`
			: r.action.kind === 'install'
				? `Instalar: ${r.action.packages.map((p) => p.spec).join(', ')}`
				: `Conceder a este agente el acceso existente ${r.action.name}. No se modifica el acceso ni sus concesiones a otros agentes.`;
	return `Diagnóstico/propuesta ${r.code}\n${r.reason}\n\n${change}\n\n${r.policy}\n${REPAIR_LABEL[r.status]}${r.result ? `\n${r.result}` : ''}${r.status === 'pending' ? `\n\nResponde AUTORIZAR ${r.code} o RECHAZAR ${r.code}. Sólo puede hacerlo el dueño. No envíes credenciales por chat.` : ''}`;
}
export function parseRepairDecision(text: string) {
	const m = /^(AUTORIZAR|RECHAZAR)\s+(R[A-F0-9]{12})$/i.exec(text.trim());
	return m ? { code: m[2].toUpperCase(), approve: m[1].toUpperCase() === 'AUTORIZAR' } : null;
}
