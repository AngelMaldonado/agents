-- Human-approved agent contracts; the interview is not a sandbox run.
alter table agents add column config_revision integer not null default 1;
alter table runs add column kind text not null default 'task' check (kind in ('task', 'initialize'));

create table agent_designs (
 id uuid primary key default gen_random_uuid(),
 person_id bigint not null references people(id),
 agent_id bigint references agents(id),
 applied_agent_id bigint references agents(id),
 base_revision integer,
 model text not null check (model like 'openai/%'),
 messages jsonb not null default '[]',
 contract jsonb,
 ready boolean not null default false,
 version integer not null default 0,
 status text not null default 'draft' check (status in ('draft', 'approved')),
 tokens integer not null default 0,
 busy_token uuid,
 busy_until timestamptz,
 init_run_id bigint references runs(id),
 last_error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index agent_designs_owner on agent_designs(person_id, updated_at desc);
create index agent_designs_agent on agent_designs(agent_id, person_id);
create unique index agent_designs_created_agent on agent_designs(applied_agent_id) where agent_id is null;
-- One model request per person, across tabs/designs. Expired leases are released before acquisition.
create unique index agent_designs_one_request on agent_designs(person_id) where busy_token is not null;
