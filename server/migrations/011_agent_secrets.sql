-- Credentials an owner gives one agent for its CLI tools and MCP servers (GITHUB_TOKEN…). Sealed with
-- AGENTS_MASTER_KEY, write-only from the web; they reach that agent's sandbox as environment variables.
create table agent_secrets (
 agent_id   bigint not null references agents on delete cascade,
 name       text not null check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 value_enc  text not null,
 updated_at timestamptz not null default now(),
 primary key (agent_id, name)
);
