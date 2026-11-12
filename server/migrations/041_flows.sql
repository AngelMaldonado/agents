-- Flujos (#18, Angel 5-nov-2026): a job of several steps that lasts hours or days, from a recipe the
-- owner approved in the contract. The platform keeps its steps, parks it while it waits for someone and
-- wakes the agent when a step is its own; the agent may adjust the steps within the recipe. Its saga
-- (flow_events) is the one record of what happened, and what the UI draws.
alter table messages drop constraint messages_source_check;
alter table messages add constraint messages_source_check
  check (source in ('web', 'hook', 'cron', 'whatsapp', 'delegation', 'flow'));

create table flows (
 id              bigint generated always as identity primary key,
 agent_id        bigint not null references agents on delete cascade,
 run_id          bigint references runs on delete set null,          -- the work that started it
 conversation_id bigint references conversations on delete set null, -- where the agent works on it
 recipe          jsonb not null,                                     -- frozen when it started
 params          jsonb not null,
 title           text not null,
 status          text not null default 'running'
                 check (status in ('running', 'done', 'failed', 'cancelled', 'expired')),
 waiting_for     text,                                               -- who it waits for now, in words
 waiting_since   timestamptz,
 result          jsonb,                                              -- in the recipe's «produces» shape
 summary         text,
 end_reason      text,
 wakes           int not null default 0,                             -- times it woke the agent
 asked_final     boolean not null default false,                     -- it asked the agent for the result
 deadline        timestamptz not null,
 created_at      timestamptz not null default now(),
 updated_at      timestamptz not null default now(),
 ended_at        timestamptz
);
create index flows_agent on flows (agent_id, created_at desc);
create index flows_live on flows (status) where status = 'running';

create table flow_steps (
 id            bigint generated always as identity primary key,
 flow_id       bigint not null references flows on delete cascade,
 key           text not null,
 position      int not null,
 title         text not null,
 kind          text not null check (kind in ('agent', 'subagent', 'delegation', 'question', 'wait')),
 depends       text[] not null default '{}',
 spec          jsonb not null,                                       -- instructions, optional, hours, encargo
 status        text not null default 'pending'
               check (status in ('pending', 'working', 'waiting', 'done', 'skipped', 'failed', 'removed')),
 result        jsonb,
 note          text,
 delegation_id bigint references delegations on delete set null,
 until         timestamptz,                                          -- a wait: when it is over
 started_at    timestamptz,
 ended_at      timestamptz,
 unique (flow_id, key)
);

create table flow_events (
 id       bigint generated always as identity primary key,
 flow_id  bigint not null references flows on delete cascade,
 step_key text,
 kind     text not null,                                             -- started, planned, step, wake, …
 text     text not null,
 data     jsonb,
 at       timestamptz not null default now()
);
create index flow_events_flow on flow_events (flow_id, id);

-- What people said for it (the owner's answers, what contacts established): carried into every wake.
create table flow_facts (
 id      bigint generated always as identity primary key,
 flow_id bigint not null references flows on delete cascade,
 source  text not null check (source in ('owner', 'contact', 'agent')),
 text    text not null,
 at      timestamptz not null default now()
);

alter table delegations add column flow_step_id bigint references flow_steps on delete set null;
