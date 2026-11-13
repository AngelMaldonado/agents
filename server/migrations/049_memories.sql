-- Memoria (Angel 9-nov-2026): what an agent knows from one trabajo to the next. The agent saves and searches
-- it with platform tools (mem_save, mem_search, mem_forget); its owner sees, corrects, pins and deletes it in
-- the web. Per agent. Model and protocol after Engram (Gentleman Programming, MIT): a memory has a kind and,
-- optionally, a stable topic, and saving to the same topic updates it (keeping its earlier versions) instead
-- of piling up duplicates. Search is Spanish full text without accents, plus trigrams for typos.
create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- unaccent() is only stable (its dictionary could change): an immutable wrapper is what an index or a
-- generated column may use.
create or replace function memory_text(t text) returns text
  language sql immutable parallel safe
  as $$ select lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))) $$;

create table memories (
  id bigserial primary key,
  agent_id bigint not null references agents(id) on delete cascade,
  kind text not null check (kind in ('preference', 'person', 'place', 'procedure', 'fact', 'decision')),
  -- A stable key («super/leche», «contacto/cortez»): saving to it again updates this memory.
  topic text check (topic is null or topic ~ '^[a-z0-9][a-z0-9/_-]{0,79}$'),
  title text not null check (length(title) between 1 and 120),
  content text not null check (length(content) between 1 and 2000),
  -- Who wrote its current version: the agent, or its owner from the web.
  source text not null check (source in ('agent', 'owner')),
  conversation_id bigint references conversations(id) on delete set null,
  run_id bigint references runs(id) on delete set null,
  -- Its owner keeps it always in the agent's prompt.
  pinned boolean not null default false,
  revisions integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  used_at timestamptz,
  deleted_at timestamptz,
  search tsvector generated always as (
    setweight(to_tsvector('spanish', memory_text(coalesce(topic, '') || ' ' || title)), 'A') ||
    setweight(to_tsvector('spanish', memory_text(content)), 'B')
  ) stored
);
create unique index memories_topic on memories (agent_id, topic) where deleted_at is null and topic is not null;
create index memories_agent on memories (agent_id, updated_at desc) where deleted_at is null;
create index memories_search on memories using gin (search);

-- Its earlier versions: what it said before each change, and who changed it.
create table memory_revisions (
  id bigserial primary key,
  memory_id bigint not null references memories(id) on delete cascade,
  title text not null,
  content text not null,
  source text not null,
  changed_by text not null check (changed_by in ('agent', 'owner')),
  created_at timestamptz not null default now()
);
create index memory_revisions_memory on memory_revisions (memory_id, created_at desc);
