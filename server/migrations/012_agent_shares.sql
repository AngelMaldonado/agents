-- An owner shares an agent with other people, who may use it: watch, chat, give it tasks and answer
-- it. Its configuration stays the owner's, and its runs keep counting against the owner's account.
create table agent_shares (
 agent_id   bigint not null references agents on delete cascade,
 person_id  bigint not null references people on delete cascade,
 created_at timestamptz not null default now(),
 primary key (agent_id, person_id)
);
create index agent_shares_person on agent_shares(person_id);
