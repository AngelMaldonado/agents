-- Agents v2: the app's schema (public). DBOS keeps its own tables in schema dbos of this same
-- database. Spec and rationale: Bubble, project agents, docs/arquitectura.md.

-- ── People and access ────────────────────────────────────────────────
create table people (
  id          bigint generated always as identity primary key,
  name        text not null,
  key         text not null unique,                 -- the name without case or accents
  avatar_seed text not null,
  run_quota   int  not null default 3 check (run_quota between 0 and 60),
  created_at  timestamptz not null default now()
);

create table sessions (
  token_hash   bytea primary key,                   -- sha256 of the agents_session cookie
  person_id    bigint not null references people on delete cascade,
  admin_until  timestamptz,                         -- the admin PIN was typed in this browser
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table invites (                              -- an admin's one-time link to enter as someone
  code_hash  bytea primary key,
  person_id  bigint not null references people on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table provider_keys (
  person_id  bigint not null references people on delete cascade,
  provider   text not null check (provider in ('anthropic', 'openai')),
  key_enc    text not null,
  last4      text not null,
  updated_at timestamptz not null default now(),
  primary key (person_id, provider)
);

create table proxy_accounts (                       -- a person's own CLIProxyAPI
  person_id  bigint primary key references people on delete cascade,
  url        text not null,                         -- base, without /v1
  key_enc    text not null,
  last4      text not null,
  updated_at timestamptz not null default now()
);

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── Agents ───────────────────────────────────────────────────────────
create table agents (
  id         bigint generated always as identity primary key,
  person_id  bigint not null references people on delete cascade,
  name       text not null,
  role       text not null default '',
  model      text not null,
  seed       text not null,
  state_ref  text not null,                         -- AgentState: the agent's Docker volume
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index agents_person on agents (person_id) where deleted_at is null;

create table agent_webhooks (
  agent_id       bigint primary key references agents on delete cascade,
  in_token       text not null unique,
  in_secret_enc  text not null,
  in_rotated_at  timestamptz not null default now(),
  out_url        text,
  out_secret_enc text not null,
  out_rotated_at timestamptz not null default now()
);

create table conversations (
  id            bigint generated always as identity primary key,
  agent_id      bigint not null references agents on delete cascade,
  pi_session_id text not null,
  started_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create unique index conversations_current on conversations (agent_id) where archived_at is null;

-- ── Runs ─────────────────────────────────────────────────────────────
create table runs (
  id                   bigint generated always as identity primary key,
  agent_id             bigint not null references agents on delete cascade,
  person_id            bigint not null references people on delete cascade,
  conversation_id      bigint not null references conversations,
  workflow_id          text not null unique,        -- DBOS: run-<id>
  model                text not null,
  priority             int  not null default 10,    -- DBOS: lower goes first; 0 = admin
  status               text not null check (status in
                         ('queued','starting','running','blocked','done','incomplete','cancelled','error')),
  state                text not null default 'idle',
  bootstrap_token_hash bytea unique,
  session_token_hash   bytea unique,
  llm_token_hash       bytea unique,
  container_id         text,
  answer               text,
  result               jsonb,                       -- the POC's result.json; goes away with the general agents thread
  cost                 numeric(12,6) not null default 0,
  tokens               bigint not null default 0,
  event_seq            int not null default 0,      -- last run_events.seq handed out
  end_reason           text,
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  ended_at             timestamptz
);
create index runs_agent on runs (agent_id, id desc);
create index runs_person_live on runs (person_id, status)
  where status in ('queued','starting','running','blocked');
-- One live run per agent: they share the agent's volume and pi session.
create unique index runs_one_live_per_agent on runs (agent_id)
  where status in ('queued','starting','running','blocked');

create table run_events (
  run_id bigint not null references runs on delete cascade,
  seq    int    not null,
  at     timestamptz not null default now(),
  kind   text   not null,
  data   jsonb  not null,
  primary key (run_id, seq)
);

-- ── Inbox and files ──────────────────────────────────────────────────
create table messages (
  id               bigint generated always as identity primary key,
  agent_id         bigint not null references agents on delete cascade,
  source           text not null check (source in ('web','hook','cron')),
  sender           text,
  person_id        bigint references people on delete set null,
  schedule_name    text,                            -- the DBOS schedule that fired it
  text             text not null,
  context          jsonb,
  new_conversation boolean not null default false,
  dedupe_key       text,
  received_at      timestamptz not null default now(),
  run_id           bigint references runs on delete set null,
  routed_as        text check (routed_as in ('new_run','queued_with','follow_up','unblock')),
  routed_at        timestamptz,
  unique (agent_id, dedupe_key)
);
create index messages_agent on messages (agent_id, id desc);
create index messages_run on messages (run_id);
create index messages_pending on messages (agent_id) where routed_at is null;

create table files (
  id         bigint generated always as identity primary key,
  direction  text not null check (direction in ('in','out')),
  message_id bigint references messages on delete cascade,
  run_id     bigint references runs on delete cascade,
  name       text not null,
  path       text not null,                         -- relative to AGENTS_DATA
  mime       text not null,
  size       bigint not null,
  created_at timestamptz not null default now(),
  check ((direction = 'in' and message_id is not null) or (direction = 'out' and run_id is not null))
);
create unique index files_run_name on files (run_id, name) where direction = 'out';

-- ── Outbound webhook ─────────────────────────────────────────────────
create table webhook_deliveries (
  id           bigint generated always as identity primary key,
  agent_id     bigint not null references agents on delete cascade,
  run_id       bigint references runs on delete set null,
  event        text not null check (event in ('done','incomplete','error','cancelled','blocked')),
  url          text not null,
  payload      jsonb not null,
  status       text not null check (status in ('pending','delivered','failed')),
  attempts     int  not null default 0,
  last_code    int,
  last_error   text,
  next_at      timestamptz,
  resend_of    bigint references webhook_deliveries,
  workflow_id  text unique,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz
);
create index webhook_deliveries_agent on webhook_deliveries (agent_id, id desc);

-- ── Site vault ───────────────────────────────────────────────────────
create table credentials (
  id           bigint generated always as identity primary key,
  person_id    bigint not null references people on delete cascade,
  name         text not null,
  origin       text not null,
  login_url    text not null,
  username_enc text not null,
  password_enc text not null,
  totp_enc     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (person_id, name)
);

create table credential_grants (
  credential_id bigint not null references credentials on delete cascade,
  agent_id      bigint not null references agents on delete cascade,
  primary key (credential_id, agent_id)
);

create table credential_uses (
  id              bigint generated always as identity primary key,
  credential_id   bigint references credentials on delete set null,
  credential_name text not null,
  action          text not null check (action in ('login','purge')),
  person_id       bigint not null references people on delete cascade,
  agent_id        bigint references agents on delete set null,
  run_id          bigint references runs on delete set null,
  at              timestamptz not null default now(),
  ok              boolean not null,
  detail          text not null
);
