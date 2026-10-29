-- WhatsApp: one number linked by an admin (the whatsapp bridge, whatsmeow) shared by every agent.
-- The bridge keeps its device session in its own schema of this database.
create schema if not exists whatsmeow;

alter table messages drop constraint messages_source_check;
alter table messages add constraint messages_source_check check (source in ('web', 'hook', 'cron', 'whatsapp'));

-- The owner turns WhatsApp on per agent and lists who may write to it.
alter table agents add column whatsapp_enabled boolean not null default false;
create table whatsapp_contacts (
 agent_id   bigint not null references agents on delete cascade,
 phone      text not null check (phone ~ '^[0-9]{8,15}$'), -- country code and number, digits only
 label      text not null default '',
 notify     boolean not null default false,               -- also hears how scheduled and webhook work ended
 created_at timestamptz not null default now(),
 primary key (agent_id, phone)
);
create index whatsapp_contacts_phone on whatsapp_contacts(phone);

-- The agent each phone is talking to now (/agente <nombre> changes it).
create table whatsapp_sessions (
 phone      text primary key,
 agent_id   bigint references agents on delete set null,
 updated_at timestamptz not null default now()
);
