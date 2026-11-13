-- Aprendizajes (Angel 12-nov-2026): what an agent learns by itself, apart from its contract. After each
-- trabajo the evaluator (the same call that scores it) proposes small changes to the list: a new lesson
-- (an answer of its owner, a mistake and how to avoid it, a stable fact), a fix, a mark of useful or
-- harmful, a removal. The list goes into its prompt («Lo que aprendiste»), capped; its owner sees it,
-- pins what must stay and deletes what is wrong. A lesson is data, never a permission.
create table agent_lessons (
  id              bigint generated always as identity primary key,
  agent_id        bigint not null references agents on delete cascade,
  text            text not null,
  conversation_id bigint references conversations on delete set null, -- the trabajo it came from
  helpful         int not null default 0,
  harmful         int not null default 0,
  pinned          boolean not null default false,                       -- its owner keeps it: the curator never drops it
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index agent_lessons_agent on agent_lessons (agent_id, id);
