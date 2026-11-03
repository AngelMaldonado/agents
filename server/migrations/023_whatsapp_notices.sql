-- What agents sent on their own by WhatsApp (#18, tool whatsapp_notify): to whom, from which run. It
-- caps them (3 per run, 10 per recipient a day) and shows them in the run's activity.
create table whatsapp_notices (
 id         bigint generated always as identity primary key,
 agent_id   bigint not null references agents on delete cascade,
 run_id     bigint references runs on delete set null,
 number_id  bigint not null references whatsapp_numbers on delete cascade,
 phone      text not null,
 at         timestamptz not null default now()
);
create index whatsapp_notices_recipient on whatsapp_notices (number_id, phone, at);
create index whatsapp_notices_run on whatsapp_notices (run_id);
