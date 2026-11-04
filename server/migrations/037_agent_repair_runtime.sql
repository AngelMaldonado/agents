-- Upgrade dev installs that applied the initial 036 before runtime diagnoses/request hashes existed.
-- Also safe after the complete 036 on a fresh database. Never invent a hash for a historic request.
create table if not exists agent_diagnoses (
 agent_id bigint primary key references agents(id) on delete cascade,
 person_id bigint not null references people(id) on delete cascade,
 run_id bigint not null references runs(id) on delete cascade,
 revision integer not null,
 report jsonb not null,
 checked_at timestamptz not null default now()
);
alter table agent_repairs add column if not exists request_digest text;
update agent_repairs set request_digest='legacy:'||id::text where request_digest is null;
alter table agent_repairs alter column request_digest set not null;
