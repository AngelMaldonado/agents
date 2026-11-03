-- cuby-whatsapp as a channel for everyone's agents (#18): the company number, shared with contact and
-- cuby.work. Agents is one integration of that service (one key, one consumer); when an admin turns it on,
-- it shows as one more number ("Cuby WhatsApp", provider 'cuby', jid 'cuby') that any person picks for
-- their agents. Its allow list is kept by admins; each person links their own phone with /vincular.
alter table whatsapp_numbers add column provider text not null default 'bridge' check (provider in ('bridge', 'cuby'));

create table cuby_whatsapp (
 id               int primary key default 1 check (id = 1),
 enabled          boolean not null default false,
 mode             text not null default 'test' check (mode in ('live', 'test')),
 live_key         text,                                  -- sealed (crypto.seal); never shown again
 live_last4       text,
 test_key         text,                                  -- sealed
 test_last4       text,
 daily_per_person int not null default 100 check (daily_per_person between 1 and 500),
 shown_phone      text not null default '',              -- the company number, to tell people where to write
 cursor           bigint not null default 0,             -- GET /v1/events?after=
 updated_at       timestamptz not null default now()
);
insert into cuby_whatsapp (id) values (1);

-- A person proves a phone is theirs by writing «/vincular <code>» from it to the company number.
create table whatsapp_link_codes (
 person_id  bigint primary key references people on delete cascade,
 phone      text not null check (phone ~ '^[0-9]{8,15}$'),
 code       text not null,
 expires_at timestamptz not null
);

-- The thread of cuby-whatsapp an awake agent's session talks in (closed when it sleeps).
alter table whatsapp_chats add column thread_id text;

-- Agents' own cap per person and day, so nobody spends the number's shared daily limit.
create table cuby_whatsapp_usage (
 person_id bigint not null references people on delete cascade,
 day       date not null,
 sent      int not null default 0,
 primary key (person_id, day)
);
