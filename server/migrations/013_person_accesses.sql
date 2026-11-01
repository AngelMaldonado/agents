-- A person's own API keys and MCP servers, granted to their agents like site logins (#24).
-- Values are sealed (crypto.ts) and never shown again. A key with domains reaches the agent only as
-- a placeholder that the egress proxy swaps for its value towards those domains; expose_real hands
-- the agent the value itself (non-HTTP tools, client-side signatures, keys migrated without domains).

create table person_keys (
  id          bigint generated always as identity primary key,
  person_id   bigint not null references people on delete cascade,
  name        text not null,                         -- the variable: GITHUB_TOKEN (Q4: unique per person)
  value_enc   text not null,
  domains     text[] not null default '{}',          -- api.github.com, *.example.com
  expose_real boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (person_id, name),
  check (expose_real or cardinality(domains) > 0)
);

create table person_key_grants (
  key_id   bigint not null references person_keys on delete cascade,
  agent_id bigint not null references agents on delete cascade,
  primary key (key_id, agent_id)
);
create index person_key_grants_agent on person_key_grants (agent_id);

-- headers/env: [{name, secret, value?, value_enc?}]; a secret pair keeps only value_enc.
create table person_mcp (
  id          bigint generated always as identity primary key,
  person_id   bigint not null references people on delete cascade,
  name        text not null,                         -- slug, as in a harness (mcp__<name>__<tool>)
  description text not null default '',
  transport   text not null check (transport in ('http', 'stdio')),
  url         text,
  command     text,
  args        jsonb not null default '[]',
  headers     jsonb not null default '[]',
  env         jsonb not null default '[]',
  domains     text[] not null default '{}',          -- where its secrets may go (http: its URL's host)
  expose_real boolean not null default false,
  oauth       boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (person_id, name)
);

create table person_mcp_grants (
  mcp_id   bigint not null references person_mcp on delete cascade,
  agent_id bigint not null references agents on delete cascade,
  primary key (mcp_id, agent_id)
);
create index person_mcp_grants_agent on person_mcp_grants (agent_id);

-- Signing a granted MCP server out of an agent's volume at its next run (revoked or deleted, Q6).
create table mcp_logouts (
  id         bigint generated always as identity primary key,
  agent_id   bigint not null references agents on delete cascade,
  server     text not null,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);

-- The run's credential towards the egress proxy (its hash): which run, so which agent's keys.
alter table runs add column proxy_token_hash bytea unique;
