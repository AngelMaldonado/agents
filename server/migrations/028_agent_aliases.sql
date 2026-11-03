-- Each person's own short names for the agents they use (theirs and the ones shared with them): «rd» for
-- Radar Dev. They pick an agent in WhatsApp (/agente rd, «rd: …», @rd) and in the web (@rd sends it a
-- message from any chat). Personal: two people may use the same alias for different agents (Angel,
-- 2-nov-2026).
create table agent_aliases (
 person_id  bigint not null references people on delete cascade,
 agent_id   bigint not null references agents on delete cascade,
 alias      text not null check (alias ~ '^[a-z0-9][a-z0-9_-]{0,23}$'),
 created_at timestamptz not null default now(),
 primary key (person_id, alias)
);
create index agent_aliases_agent on agent_aliases (person_id, agent_id);
