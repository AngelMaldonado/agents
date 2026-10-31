import type { CharState } from './Character';
import type { Harness } from '../../sandbox/harness';
export type { Harness } from '../../sandbox/harness';
export type HarnessValidation = {
	status: 'passed' | 'failed';
	version: number;
	digest: string;
	harnessDigest: string;
	imageId: string;
	at: number;
	checks: string[];
	tools: string[];
	error?: string;
};

export type Person = { id: number; name: string; avatar_seed: string; admin: boolean };
export type Model = { id: string; label: string };
export type PublicSettings = {
	models: Model[];
	maxConcurrent: number;
	maxMinutes: number;
	maxCostUsd: number;
	blockedWaitMinutes: number;
	sandboxImage: string;
};
export type Status = 'queued' | 'starting' | 'running' | 'blocked' | 'done' | 'incomplete' | 'cancelled' | 'error';
export type Task = {
	id: number;
	agent_id: number;
	person_id: number;
	prompt: string;
	model: string;
	status: Status;
	state: CharState;
	kind?: 'task' | 'initialize' | 'browser';
	control?: boolean; // the owner is driving the agent's browser (takeover)
	controller?: number | null;
	cost: number;
	tokens: number;
	end_reason: string | null;
	answer: string | null;
	conversation_id: number;
	requested_by?: number | null;
	requested_by_name?: string | null; // someone it is shared with; null: its owner
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
	definition?: { revision: number; digest: string; harnessDigest: string; image: string | null } | null;
};
export type Agent = {
	id: number;
	person_id: number;
	name: string;
	role: string;
	model: string;
	seed: string;
	created_at: number;
	owner: string;
	task: Task | null;
	config_revision?: number;
	setup_design_id?: string | null;
	harness?: Harness;
	shares?: number[]; // the people it is shared with (they run tasks; configuration is the owner's)
};
export type Contract = { name: string; prompt: string };
export type AgentTool = { id: string; name: string; description: string };
export type Question = {
	id: string;
	title: string;
	description: string;
	selectionMode: 'single' | 'multi';
	options: { id: string; label: string; description: string }[];
	recommended: string | null;
};
export type InterviewAnswers = { round: number; values: Record<string, { selected: string[]; other: string }> };
export type DesignMessage = {
	role: 'user' | 'assistant';
	content: string;
	questions?: Question[];
	questionRound?: number;
	answers?: InterviewAnswers;
	attachments?: { id: string; name: string; mime: string; size: number }[];
};
export type Design = {
	id: string;
	agent_id: number | null;
	applied_agent_id: number | null;
	model: string;
	version: number;
	messages: DesignMessage[];
	contract: Contract | null;
	ready: boolean;
	interview?: {
		phase: 'questions' | 'review' | 'restore';
		completed: number;
		pending: { round: number; questions: Question[] } | null;
	};
	restored_revision?: number | null;
	status: 'draft' | 'approved';
	tokens: number;
	busy_until: number | null;
	stale: boolean;
	init_run_id: number | null;
	last_error?: string | null;
	effectivePrompt: string | null;
	currentContract: Contract | null;
	tools: AgentTool[];
	harness?: Harness;
	currentHarness?: Harness | null;
	harness_validation?: HarnessValidation | null;
	validation_pending?: boolean;
	schedules?: { cron: string; message: string }[] | null;
	currentSchedules?: { name: string; cron: string; message: string; status: string; timezone?: string }[];
	scheduleTimezone?: string;
	initialization: {
		task: Task | null;
		error: string | null;
		steps: { id: string; label: string; done: boolean }[];
	} | null;
};
export type BrowserSnapshot = { jpeg: string; url: string; captured_at: number };
export type TaskEvent = { id: number; at: number; kind: string; data: any };
export type Artifact = { id: number; name: string; mime: string; size: number };
export type Conversation = {
	id: number;
	agent_id: number;
	title: string;
	is_default: boolean;
	started_at: number;
	archived_at: number | null;
	runs: number;
};
export type WorkRecord = { task: Task; events: TaskEvent[]; artifacts: Artifact[] };
export type ConversationInput = {
	id: number;
	text: string;
	source: string;
	received_at: number;
	run_id: number | null;
	routed_as: string | null;
	routed_at: number | null;
	context?: { helpRound?: number } | null;
	files?: { name: string; mime: string; size: number }[];
};
export type ConversationPage = {
	conversation: Conversation;
	records: WorkRecord[];
	inputs: ConversationInput[];
	hasEarlier: boolean;
	before: number | null;
};
export type Credential = {
	id: number;
	name: string;
	origin: string;
	login_url: string;
	updated_at: number;
	agents: number[];
};

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method: init?.method ?? (init?.body ? 'POST' : 'GET'),
		headers: init?.body ? { 'content-type': 'application/json' } : undefined,
		body: init?.body ? JSON.stringify(init.body) : undefined,
		credentials: 'same-origin',
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
	return data as T;
}

export const isLive = (t: Task | null | undefined) =>
	!!t && ['queued', 'starting', 'running', 'blocked'].includes(t.status);
/** Running, or waiting for a human: either way its supervisor takes steers. */
export const isWorking = (t: Task | null | undefined) => !!t && (t.status === 'running' || t.status === 'blocked');

export function ago(ms: number) {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return `hace ${s}s`;
	if (s < 3600) return `hace ${Math.round(s / 60)} min`;
	if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
	return new Date(ms).toLocaleDateString('es-MX');
}

export const money = (n: number | null | undefined, currency = 'MXN') =>
	n == null ? '—' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(n);
