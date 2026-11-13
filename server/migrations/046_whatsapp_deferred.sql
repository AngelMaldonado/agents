-- A notice whatsapp_notify got in the quiet hours (22:00 to 7:00) waits here and goes out at 7:00 by
-- itself, with the same checks as when it is sent at once (who is enabled, the caps).
create table whatsapp_deferred (
 id         bigint generated always as identity primary key,
 agent_id   bigint not null references agents on delete cascade,
 run_id     bigint not null references runs on delete cascade,
 input      jsonb not null,
 send_at    timestamptz not null,
 sent_at    timestamptz,
 result     jsonb,
 created_at timestamptz not null default now()
);
create index whatsapp_deferred_due on whatsapp_deferred (send_at) where sent_at is null;
