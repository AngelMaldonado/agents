// What the admin sets behind the PIN: global limits, the model catalog and the sandbox image.
import { db } from './db';

export type Settings = {
	maxConcurrent: number; // tasks running at once; the rest wait in the queue
	maxMinutes: number; // a task that runs longer ends as incomplete
	maxCostUsd: number; // per task, from the usage pi reports
	blockedWaitMinutes: number; // how long a stuck agent waits for a steer before skipping
	sandboxImage: string;
	// provider/model. The id must exist in pi's catalog AND in CLIProxyAPI's (it lacks some
	// aliases, e.g. claude-haiku-4-5: use the dated id).
	models: { id: string; label: string }[];
};

const DEFAULTS: Settings = {
	maxConcurrent: 3,
	maxMinutes: 30,
	maxCostUsd: 2,
	blockedWaitMinutes: 10,
	sandboxImage: process.env.BUYER_SANDBOX_IMAGE ?? 'buyer-sandbox:dev',
	models: [
		{ id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
		{ id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
		{ id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
		{ id: 'openai/gpt-6-sol', label: 'GPT-6 Sol' }
	]
};

export function settings(): Settings {
	const row = db.query("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | null;
	return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
}

export function saveSettings(patch: Partial<Settings>) {
	const next = { ...settings(), ...clean(patch) };
	db.query(
		"INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
	).run(JSON.stringify(next));
	return next;
}

function clean(p: Partial<Settings>): Partial<Settings> {
	const out: Partial<Settings> = {};
	const int = (v: unknown, lo: number, hi: number) =>
		typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined;
	if (p.maxConcurrent !== undefined) out.maxConcurrent = int(p.maxConcurrent, 1, 5);
	if (p.maxMinutes !== undefined) out.maxMinutes = int(p.maxMinutes, 1, 120);
	if (p.blockedWaitMinutes !== undefined) out.blockedWaitMinutes = int(p.blockedWaitMinutes, 1, 60);
	if (typeof p.maxCostUsd === 'number' && p.maxCostUsd > 0) out.maxCostUsd = Math.min(50, p.maxCostUsd);
	if (typeof p.sandboxImage === 'string' && /^[\w./:@-]+$/.test(p.sandboxImage)) out.sandboxImage = p.sandboxImage;
	if (Array.isArray(p.models)) {
		out.models = p.models
			.filter((m) => m && /^(anthropic|openai)\/[\w.-]+$/.test(m.id))
			.map((m) => ({ id: m.id, label: String(m.label || m.id).slice(0, 60) }));
	}
	for (const k of Object.keys(out) as (keyof Settings)[]) if (out[k] === undefined) delete out[k];
	return out;
}
