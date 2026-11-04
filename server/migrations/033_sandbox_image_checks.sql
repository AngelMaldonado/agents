-- Short, crash-recoverable leases share the existing global harness validation budget.
create table sandbox_image_checks (
    agent_id integer primary key references agents(id) on delete cascade,
    person_id integer not null unique references people(id) on delete cascade,
    token uuid not null,
    expires_at timestamptz not null
);
