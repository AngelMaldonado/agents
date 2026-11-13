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
	managed?: boolean; // made from the admin's catalog (not built yet: always false for now)
	/** The viewer's own aliases for it (personal), and the handle every agent answers to (@radar-dev). */
	aliases?: string[];
	handle?: string;
	/** Yours or shared with you: you can write to it (an admin sees others' agents without using them). */
	usable?: boolean;
	/** Hours without activity that close one of its trabajos. */
	inactivity_hours?: number;
	/** Pagos simulados: its payments are intercepted and it sees them as done (to test flows). */
	simulated_payments?: boolean;
	/** Conversaciones simuladas: its WhatsApp goes to the simulator. */
	simulated_conversations?: boolean;
	/** Modo objetivo: its trabajos go on by themselves until their objective is met. */
	goal_mode?: boolean;
	/** Personalidad: its owner's five dials (shared/personality.ts); absent: the platform's default. */
	personality?: Record<string, number> | null;
	/** Estilo (shared/souls.ts): its preset (null: Cuby YOLO) and its owner's own text, if any. */
	style?: string | null;
	soul?: string | null;
};
/** GET /api/search: a match in what someone said to an agent, or what it answered. */
export type SearchHit = {
	kind: 'message' | 'answer';
	agent_id: number;
	conversation_id: number;
	conversation_title: string;
	run_id: number | null;
	snippet: string;
	at: number;
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
	/** The model's reasoning summary for this reply (shown folded). */
	reasoning?: string;
	/** The designer's searches in this reply, what they found and the secrets it asked for. */
	searches?: DesignSearch[];
	findings?: Finding[];
	secrets?: SecretRequest[];
};
export type DesignProgress = {
	phase: 'reading' | 'thinking' | 'searching' | 'questions' | 'writing' | 'contract';
	reasoning: string;
	searches: { tool: string; query: string; results?: number; error?: string; done: boolean }[];
	started: number;
};
export type DesignSearch = { tool: string; query: string; results: number; error?: string };
export type FindingField = {
	name: string;
	description: string;
	secret: boolean;
	target: 'header' | 'env';
	template: string | null;
	value: string | null;
};
export type Finding = {
	id: string;
	kind: 'mcp' | 'cli' | 'skill';
	name: string;
	title: string;
	description: string;
	version: string | null;
	url: string | null;
	fields: FindingField[];
	mcp?: { transport: 'http'; url: string; oauth: boolean } | { transport: 'stdio'; command: string; args: string[] };
	status?: 'pending' | 'added' | 'skipped';
	added?: { access?: string; skill?: string; source?: string };
};
export type SecretRequest = { name: string; description: string; domains: string[]; saved?: boolean };
export type AccessSuggestion = {
	kind: 'site' | 'mcp' | 'key';
	id: number;
	name: string;
	detail: string;
	reason: string;
	granted: boolean;
	/** Chosen before the agent exists: granted when it is approved. */
	accepted?: boolean;
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
	/** The person's accesses the designer suggests; `granted`: the agent (or the one being set up) has it. */
	accessSuggestions?: AccessSuggestion[];
	/** What the isolated harness test checks. */
	harnessChecks?: string[];
	/** While the designer answers: what it is doing, written as it streams. */
	progress?: DesignProgress | null;
	initialization: {
		task: Task | null;
		/** What it proved: CLI tools installed, MCP servers that answered, keys in its environment. */
		check: AccessCheck | null;
		error: string | null;
		steps: { id: string; label: string; done: boolean }[];
	} | null;
	/** Modo objetivo proposed (null: keeps the agent's). */
	goal_mode?: boolean | null;
};
export type AccessCheck = {
	tools: { ok: boolean; names: string[]; detail?: string };
	mcp: { name: string; ok: boolean | null; tools?: number; detail?: string }[];
	keys: string[];
	undelivered: string[];
};
export type BrowserSnapshot = { jpeg: string; url: string; captured_at: number };
export type TaskEvent = { id: number; at: number; kind: string; data: any };
export type Artifact = { id: number; name: string; mime: string; size: number };
export type Conversation = {
	id: number;
	agent_id: number;
	title: string;
	is_default: boolean;
	/** Where it started: web, whatsapp, cron, hook (null: the Principal, or before 042). */
	origin?: string | null;
	started_at: number;
	archived_at: number | null;
	runs: number;
	last_at?: number; // its latest message or run («Recientes»)
	/** It has a run in the queue or working now. */
	live?: boolean;
	/** As a trabajo: its objective and state (the Principal is not one). */
	goal?: string | null;
	status?: 'open' | 'done' | 'closed';
	closed_at?: number | null;
	end_reason?: string | null;
	/** Its evaluation, 0 to 100. */
	score?: number | null;
	/** Its evaluation's state: pending while another agent evaluates it. */
	evaluation?: 'pending' | 'done' | 'failed' | null;
	/** How many of its agent's lessons came from it (Aprendizajes). */
	learned?: number;
	/** Its list of tasks: how many, how many over, and the one going on now. */
	tasks?: number;
	tasks_done?: number;
	task_now?: string | null;
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
/** A person's API Key (#24): the variable, where the proxy may put it, and who has it. */
export type AccessKey = {
	id: number;
	name: string;
	domains: string[];
	expose_real: boolean;
	updated_at: number;
	agents: number[];
};
export type AccessPair = { name: string; secret: boolean; value: string | null };
/** A person's MCP server (#24); secret values never come back. */
export type AccessMcp = {
	id: number;
	name: string;
	description: string;
	transport: 'http' | 'stdio';
	url: string | null;
	command: string | null;
	args: string[];
	headers: AccessPair[];
	env: AccessPair[];
	domains: string[];
	expose_real: boolean;
	oauth: boolean;
	updated_at: number;
	agents: number[];
};
export type AccessView = { keys: AccessKey[]; mcp: AccessMcp[]; proxyReady: boolean };
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
