create table computer_update_jobs (
    id uuid primary key,
    person_id integer not null references people(id) on delete cascade,
    request_id uuid not null,
    request_hash text not null,
    target jsonb not null,
    pull_ref text,
    status text not null default 'queued' check (status in ('queued','preparing','running','done','partial','failed','cancelled')),
    message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (person_id, request_id)
);
create table computer_update_items (
    job_id uuid not null references computer_update_jobs(id) on delete cascade,
    agent_id integer not null references agents(id) on delete cascade,
    name text not null,
    revision integer not null,
    definition_digest text not null,
    status text not null default 'queued' check (status in ('queued','waiting','validating','applying','done','failed','cancelled')),
    error text,
    applied_revision integer,
    updated_at timestamptz not null default now(),
    primary key (job_id, agent_id)
);
create unique index computer_update_one_active on computer_update_items(agent_id)
    where status in ('queued','waiting','validating','applying');
create index computer_update_jobs_owner on computer_update_jobs(person_id, created_at desc);
