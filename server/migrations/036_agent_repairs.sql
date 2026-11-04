create table agent_diagnoses (
 agent_id bigint primary key references agents(id) on delete cascade,
 person_id bigint not null references people(id) on delete cascade,
 run_id bigint not null references runs(id) on delete cascade,
 revision integer not null,
 report jsonb not null,
 checked_at timestamptz not null default now()
);

create table agent_repairs (
 id uuid primary key,
 code text not null unique,
 agent_id bigint not null references agents(id) on delete cascade,
 person_id bigint not null references people(id) on delete cascade,
 run_id bigint not null references runs(id) on delete cascade,
 conversation_id bigint not null references conversations(id) on delete cascade,
 revision integer not null,
 definition_digest text not null,
 request_id text not null,
 request_digest text not null,
 status text not null check(status in ('pending','approved','running','done','failed','rejected','expired')),
 reason text not null,
 action jsonb not null,
 before jsonb not null,
 automatic boolean not null default false,
 policy text not null,
 result text,
 decided_by bigint references people(id),
 decided_at timestamptz,
 continuation_id bigint references messages(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '24 hours',
 unique(run_id,request_id)
);
create index agent_repairs_active on agent_repairs(agent_id) where status in ('pending','approved','running');
create unique index agent_repairs_one_execution on agent_repairs(agent_id) where status in ('approved','running');
