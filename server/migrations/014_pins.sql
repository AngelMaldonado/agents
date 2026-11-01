-- What each person pins to the top of their sidebar: agents and conversations (Bubble agents #25).
-- Personal: pinning never changes the agent or the conversation for anyone else.
create table pins (
  person_id bigint not null references people on delete cascade,
  kind      text not null check (kind in ('agent','conversation')),
  ref_id    bigint not null,
  pinned_at timestamptz not null default now(),
  primary key (person_id, kind, ref_id)
);
