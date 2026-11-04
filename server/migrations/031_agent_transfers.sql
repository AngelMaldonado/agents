-- An agent given to someone else (transfer: it changes hands) or copied for them (copy: a new agent with
-- its configuration and no credentials). Kept to know who did it and when.
create table agent_transfers (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('transfer', 'copy')),
  agent_id     bigint not null references agents(id),
  copy_id      bigint references agents(id),
  from_person  bigint not null references people(id),
  to_person    bigint not null references people(id),
  by_person    bigint not null references people(id),
  detail       jsonb not null default '{}',
  at           timestamptz not null default now()
);
create index agent_transfers_agent on agent_transfers (agent_id);
