-- WhatsApp with Agents' own numbers (#18): any person links theirs by QR, an admin offers public numbers
-- (with an alias, everyone may pick them) and private ones (admins only), and each agent talks through
-- the number its owner picked. Each number has an allow and a block list of phones. The bridge keeps
-- the device sessions in schema whatsmeow (009).
--
-- 009's model goes: one shared number, contacts per agent and a phone → agent session.
drop table if exists whatsapp_sessions;
drop table if exists whatsapp_contacts;
alter table agents drop column if exists whatsapp_enabled;

create table whatsapp_numbers (
 id          bigint generated always as identity primary key,
 owner_id    bigint not null references people on delete cascade, -- who linked it
 scope       text not null default 'personal' check (scope in ('personal', 'public', 'private')),
 alias       text not null default '',                              -- what others see (public numbers)
 jid         text unique,                                           -- the bridge's device; null while pairing
 phone       text check (phone ~ '^[0-9]{8,15}$'),
 name        text not null default '',                              -- the account's WhatsApp name
 status      text not null default 'pairing' check (status in ('pairing', 'linked', 'unlinked', 'failed')),
 created_at  timestamptz not null default now(),
 deleted_at  timestamptz
);
-- A phone is linked once: two devices of one account would answer twice.
create unique index whatsapp_numbers_phone on whatsapp_numbers (phone) where deleted_at is null and status = 'linked';
create index whatsapp_numbers_owner on whatsapp_numbers (owner_id) where deleted_at is null;

-- The number an agent talks through, and whether its owner also hears scheduled and webhook work.
alter table agents add column whatsapp_number_id bigint references whatsapp_numbers on delete set null;
alter table agents add column whatsapp_notify boolean not null default false;

-- Who may write to a number, kept by whoever manages it: the allow list is attended, the block list is
-- refused, and any other phone is ignored (nothing reveals which agents use the number).
create table whatsapp_phones (
 number_id   bigint not null references whatsapp_numbers on delete cascade,
 phone       text not null check (phone ~ '^[0-9]{8,15}$'),         -- country code and number, digits only
 list        text not null check (list in ('allow', 'block')),
 person_id   bigint references people on delete set null,           -- allow: who writes from it; null: a guest of the number's owner
 label       text not null default '',
 created_at  timestamptz not null default now(),
 primary key (number_id, phone),
 check (list = 'allow' or person_id is null)
);

-- Which agent a phone is talking to in its one-to-one chat with a number (/agente switches), and the
-- address WhatsApp gave that chat (Mexican mobiles often 521…): answers go there, never to a guess.
create table whatsapp_chats (
 number_id   bigint not null references whatsapp_numbers on delete cascade,
 phone       text not null,                                         -- as in the lists
 reply_to    text not null,                                         -- as WhatsApp sent it
 agent_id    bigint references agents on delete set null,
 updated_at  timestamptz not null default now(),
 primary key (number_id, phone)
);
