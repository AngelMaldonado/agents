-- Direct guests (#18, Angel 4-nov-2026): a guest of the number marked «directo» never gets a group. They
-- talk one to one with the single agent whose owner switched them on, and it answers in that same chat.
alter table whatsapp_phones add column direct boolean not null default false;
alter table whatsapp_phones add constraint whatsapp_phones_direct_guest
  check (not direct or (list = 'allow' and person_id is null and not supplier));

-- A direct guest's chat: which agent it is with and, on Cuby, the thread it goes in (null on Agents' own
-- numbers). One per phone, since a direct guest talks to one agent. `notice`: what the agent last said
-- there from outside the chat's conversation (whatsapp_notify), which their next message answers.
create table whatsapp_direct_chats (
 number_id bigint not null references whatsapp_numbers on delete cascade,
 phone     text not null check (phone ~ '^[0-9]{8,15}$'),
 agent_id  bigint not null references agents on delete cascade,
 thread_id text,
 notice    text,
 last_at   timestamptz not null default now(),
 primary key (number_id, phone)
);
