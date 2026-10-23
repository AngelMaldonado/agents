import type { CharState } from './Character';

export type Person = { id: number; name: string; avatar_seed: string; admin: boolean };
export type Model = { id: string; label: string };
export type PublicSettings = {
	models: Model[]; maxConcurrent: number; maxMinutes: number; maxCostUsd: number; blockedWaitMinutes: number; sandboxImage: string;
};
export type Option = {
	product: string; vendor: string; price: number | null; currency: string; shipping: string | null; availability: string;
	url: string; screenshot?: string; checked_at?: string; notes?: string;
};
export type Quote = { summary?: string; recommendation?: { option: number; why: string }; options: Option[] };
export type Status = 'queued' | 'starting' | 'running' | 'done' | 'incomplete' | 'cancelled' | 'error';
export type Task = {
	id: number; agent_id: number; person_id: number; prompt: string; model: string; status: Status; state: CharState;
	cost: number; tokens: number; end_reason: string | null; result: Quote | null;
	created_at: number; started_at: number | null; ended_at: number | null;
};
export type Agent = {
	id: number; person_id: number; name: string; role: string; model: string; seed: string; created_at: number;
	owner: string; task: Task | null;
};
export type TaskEvent = { id: number; at: number; kind: string; data: any };
export type Artifact = { id: number; name: string; mime: string; size: number };
export type Credential = { id: number; name: string; origin: string; login_url: string; updated_at: number; agents: number[] };

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method: init?.method ?? (init?.body ? 'POST' : 'GET'),
		headers: init?.body ? { 'content-type': 'application/json' } : undefined,
		body: init?.body ? JSON.stringify(init.body) : undefined,
		credentials: 'same-origin'
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
	return data as T;
}

export const isLive = (t: Task | null | undefined) => !!t && ['queued', 'starting', 'running'].includes(t.status);

export function ago(ms: number) {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return `hace ${s}s`;
	if (s < 3600) return `hace ${Math.round(s / 60)} min`;
	if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
	return new Date(ms).toLocaleDateString('es-MX');
}

export const money = (n: number | null | undefined, currency = 'MXN') =>
	n == null ? '—' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(n);
