-- Avanzado (Angel 12-nov-2026). Its personality: five dials its owner sets (1 to 5; 3 or absent leaves the
-- platform's default), rendered as a section of its prompt. Its harness tuned by hand: each change is tested
-- in the background on its image and applied only if the test passes; if it fails, the agent stays as it was.
alter table agents add column personality jsonb;

create table harness_tunes (
  id            bigint generated always as identity primary key,
  agent_id      bigint not null references agents on delete cascade,
  person_id     bigint not null references people on delete cascade,
  base_revision int not null,                     -- the revision it changes: another change since, and it is not applied
  harness       jsonb not null,
  summary       text not null default '',         -- what changed, in its owner's words («Quitó Navegador»)
  status        text not null default 'testing' check (status in ('testing', 'waiting', 'applied', 'failed')),
  error         text,
  revision      int,                              -- the revision it became
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index harness_tunes_agent on harness_tunes (agent_id, id desc);
