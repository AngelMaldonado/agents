-- Tareas (Angel 6-nov-2026): every trabajo keeps one list of tasks that its agent and its owner see and
-- edit. That list is a flow: from a recipe (which preloads it) or free (recipe null), one running at a
-- time per trabajo. A task may be blocked (with its reason), and a wait may be for a person's reply.
alter table flows alter column recipe drop not null;
create unique index flows_one_per_conversation on flows (conversation_id)
  where status = 'running' and conversation_id is not null;
alter table flow_steps drop constraint flow_steps_status_check;
alter table flow_steps add constraint flow_steps_status_check
  check (status in ('pending', 'working', 'waiting', 'blocked', 'done', 'skipped', 'failed', 'removed'));
