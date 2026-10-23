// Buyer's database: one SQLite file (BUYER_DB, default data/buyer.db).
// People and sessions follow ~/dev/sonos: a name is the only login, admins type a shared PIN.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DATA_DIR = process.env.BUYER_DATA ?? 'data';
const path = process.env.BUYER_DB ?? `${DATA_DIR}/buyer.db`;
mkdirSync(dirname(path), { recursive: true });

export const db = new Database(path, { create: true, strict: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS people (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	key TEXT NOT NULL UNIQUE,          -- the name without case or accents: what makes it unique
	avatar_seed TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	token TEXT PRIMARY KEY,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	admin_until INTEGER NOT NULL DEFAULT 0,  -- unix ms; the shared PIN was typed in this browser
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (  -- an admin's one-time link to enter as someone again
	code TEXT PRIMARY KEY,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);
-- Each person's own provider keys, encrypted with BUYER_MASTER_KEY. Never shown again.
CREATE TABLE IF NOT EXISTS provider_keys (
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
	enc TEXT NOT NULL,
	last4 TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (person_id, provider)
);
-- A person's own CLIProxyAPI: when set, their tasks go there instead of the built-in proxy.
CREATE TABLE IF NOT EXISTS proxy_accounts (
	person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
	url TEXT NOT NULL,                  -- base URL, without /v1
	enc_key TEXT NOT NULL,
	last4 TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
-- A worker: a stable character with a role and a model. Each task gets a fresh sandbox.
CREATE TABLE IF NOT EXISTS agents (
	id INTEGER PRIMARY KEY,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT '',     -- extra instructions appended to the system prompt
	model TEXT NOT NULL,               -- provider/model, from the admin's catalog
	seed TEXT NOT NULL,                -- drives the procedural character
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
	id INTEGER PRIMARY KEY,
	agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	prompt TEXT NOT NULL,
	model TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('queued','starting','running','done','incomplete','cancelled','error')),
	state TEXT NOT NULL DEFAULT 'idle', -- what the character shows
	token TEXT UNIQUE,                  -- bootstrap: the supervisor's single-use key, burnt when it connects
	llm_token TEXT UNIQUE,              -- what pi uses for the LLM gateway; dead once the task ends
	container_id TEXT,
	cost REAL NOT NULL DEFAULT 0,
	tokens INTEGER NOT NULL DEFAULT 0,
	end_reason TEXT,
	result TEXT,                        -- the quote as JSON, when the agent wrote one
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_agent ON tasks(agent_id, id);
CREATE TABLE IF NOT EXISTS task_events (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL,                 -- text, tool, tool_end, steer, follow_up, status, blocked, error, system
	data TEXT NOT NULL                  -- JSON
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);
CREATE TABLE IF NOT EXISTS artifacts (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	path TEXT NOT NULL,
	mime TEXT NOT NULL,
	size INTEGER NOT NULL,
	UNIQUE (task_id, name)
);
-- The site vault: logins the agents may use without ever seeing them.
CREATE TABLE IF NOT EXISTS credentials (
	id INTEGER PRIMARY KEY,
	person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
	name TEXT NOT NULL,                 -- what the agent calls it: agent-browser auth login <name>
	origin TEXT NOT NULL,               -- https://host[:port] the login form must be on
	login_url TEXT NOT NULL,
	enc_username TEXT NOT NULL,
	enc_password TEXT NOT NULL,
	enc_totp TEXT,                      -- reserved; not used in v1
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (person_id, name)
);
CREATE TABLE IF NOT EXISTS credential_grants (
	credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
	agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	PRIMARY KEY (credential_id, agent_id)
);
CREATE TABLE IF NOT EXISTS credential_uses (
	id INTEGER PRIMARY KEY,
	credential_id INTEGER REFERENCES credentials(id) ON DELETE SET NULL,
	credential_name TEXT NOT NULL,
	person_id INTEGER NOT NULL,
	task_id INTEGER,
	agent_id INTEGER,
	at INTEGER NOT NULL,
	ok INTEGER NOT NULL,
	detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`);

export const now = () => Date.now();
