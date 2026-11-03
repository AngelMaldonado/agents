-- One WhatsApp group per (owner of agents, person) (#18, Angel 2-nov-2026): «Agentes <owner>» with the
-- number that hosts the groups and that person. Each person talks there to the owner's agents they may
-- use (their own, or the ones shared with them, or the ones the owner switched on for a guest); notices go
-- there too. One number hosts every group: the one an admin marks, or Cuby WhatsApp.
alter table whatsapp_numbers add column groups boolean not null default false;
create unique index whatsapp_numbers_groups on whatsapp_numbers (groups) where groups and deleted_at is null;

create table whatsapp_groups (
 id                   bigint generated always as identity primary key,
 number_id            bigint not null references whatsapp_numbers on delete cascade,
 owner_id             bigint not null references people on delete cascade,     -- whose agents
 phone                text not null check (phone ~ '^[0-9]{8,15}$'),            -- the member, as in the lists
 person_id            bigint references people on delete set null,              -- the member as a person; null: a guest
 ref                  text,                                                     -- the bridge's group JID or Cuby's thread
 title                text not null,
 status               text not null default 'creating' check (status in ('creating', 'open', 'closed', 'failed')),
 error                text,
 last_agent_id        bigint references agents on delete set null,              -- who the next message goes to
 last_conversation_id bigint references conversations on delete set null,
 pending              jsonb,                                                    -- {agents, text}: «¿para qué agente?» asked
 created_at           timestamptz not null default now(),
 updated_at           timestamptz not null default now(),
 unique (number_id, owner_id, phone)
);
create unique index whatsapp_groups_ref on whatsapp_groups (number_id, ref) where ref is not null;

-- What an agent sent into a group: a reply that quotes it goes back to that agent and conversation.
create table whatsapp_outbound (
 number_id       bigint not null references whatsapp_numbers on delete cascade,
 message_id      text not null,
 group_id        bigint not null references whatsapp_groups on delete cascade,
 agent_id        bigint references agents on delete cascade,
 conversation_id bigint references conversations on delete set null,
 text            text not null default '',                                      -- its first lines, for context
 at              timestamptz not null default now(),
 primary key (number_id, message_id)
);
