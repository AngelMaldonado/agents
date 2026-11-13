-- Trabajos (Angel 5-nov-2026): agents people hire. A trabajo is one objective in one conversation: it
-- ends when the agent meets its objective (job_done), when its owner ends it, or after hours without
-- activity; the next thing they ask opens a new one, in a new conversation, and the agent starts it
-- knowing what it did before (the summaries of its recent trabajos). Each one that ends is evaluated by
-- another agent, with the rubric of its contract. The conversation Principal is not a trabajo: it is
-- where its computer sessions and its initialization live.
alter table conversations add column goal text;
alter table conversations add column status text not null default 'open' check (status in ('open', 'done', 'closed'));
alter table conversations add column end_reason text;
alter table conversations add column summary text;
alter table conversations add column result jsonb;
alter table conversations add column closed_at timestamptz;
alter table conversations add column origin text;                                   -- web, whatsapp, cron, hook
alter table conversations add column person_id bigint references people on delete set null; -- whom it is for
alter table conversations add column rating smallint check (rating in (-1, 1));     -- its owner's 👍 / 👎
alter table conversations add column rating_note text;

-- What came before: a closed tab was a finished conversation; whom each one was for, from its first message.
update conversations set status = 'closed', closed_at = coalesce(archived_at, now()), end_reason = 'cerrada antes de los trabajos'
 where archived_at is not null and not is_default;
update conversations c set person_id = (select m.person_id from messages m where m.conversation_id = c.id and m.person_id is not null order by m.id limit 1);

alter table agents add column inactivity_hours int not null default 24 check (inactivity_hours between 1 and 720);

create table job_evaluations (
 id              bigint generated always as identity primary key,
 conversation_id bigint not null unique references conversations on delete cascade,
 agent_id        bigint not null references agents on delete cascade,
 status          text not null default 'pending' check (status in ('pending', 'done', 'failed')),
 attempts        int not null default 0,
 metrics         jsonb,                                              -- measured by the platform, no model
 scores          jsonb,                                              -- per criterion: score, weight, why, evidence
 overall         numeric(5, 1),                                      -- 0 to 100, weighted
 comment         text,
 suggestions     jsonb,
 model           text,
 tokens          int not null default 0,
 error           text,
 created_at      timestamptz not null default now(),
 done_at         timestamptz
);
create index job_evaluations_agent on job_evaluations (agent_id, created_at desc);
