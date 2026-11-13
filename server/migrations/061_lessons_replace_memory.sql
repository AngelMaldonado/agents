-- Los aprendizajes se comen a la memoria (Angel 13-nov-2026). What an agent knows is its lessons: the
-- pattern of ACE (Agentic Context Engineering, Stanford): a bank of short lessons with useful/harmful marks,
-- changed little by little, never rewritten. The agent saves one while it works (learn), the evaluator
-- reviews them when its trabajo ends, its owner teaches and pins. Each trabajo gets its playbook from the
-- bank when it starts (and again if its objective changes): the pinned ones, those relevant to it, the most
-- useful. The memory system (049) goes, with what it held: it was hardly used.
drop table if exists memory_revisions;
drop table if exists memories;
drop function if exists memory_text(text);

-- Search for a trabajo's playbook: Spanish words without accents, plus trigrams for a different spelling.
create or replace function lesson_text(t text) returns text
  language sql immutable parallel safe
  as $$ select lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))) $$;
alter table agent_lessons add column search tsvector
  generated always as (to_tsvector('spanish', lesson_text(text))) stored;
create index agent_lessons_search on agent_lessons using gin (search);

-- A trabajo's playbook (its picture: which lessons and why, [{id, why}]), the objective it was put together
-- for, and what the trabajo taught (what the agent saved, the evaluator's changes, its owner's teaching).
alter table conversations
  add column playbook jsonb,
  add column playbook_goal text,
  add column taught jsonb;

-- Trabajos from before: what each one taught is the lessons that came from it.
update conversations c set taught = l.taught
from (
  select conversation_id,
         jsonb_agg(jsonb_build_object('op', 'add', 'text', text,
                   'at', (extract(epoch from created_at) * 1000)::bigint) order by id) as taught
  from agent_lessons where conversation_id is not null group by conversation_id
) l
where c.id = l.conversation_id and c.taught is null;
