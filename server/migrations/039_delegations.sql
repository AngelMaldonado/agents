-- «Proveedor» becomes «Contacto externo» (Angel 5-nov-2026): someone outside Agents the agents talk to one
-- to one (a supplier, a client, a technician). Same rows, a name that fits them all.
alter table whatsapp_phones rename column supplier to external;
alter table whatsapp_supplier_threads rename to whatsapp_external_threads;
alter index whatsapp_supplier_threads_phone rename to whatsapp_external_threads_phone;
alter index whatsapp_supplier_threads_thread rename to whatsapp_external_threads_thread;

-- Encargos (#18, Angel 5-nov-2026): a conversation the agent delegates to a contact, with its own context
-- and one objective, run by the server (not the agent's computer) from a template its contract approved.
-- Its result goes back to the conversation that started it.
alter table messages drop constraint messages_source_check;
alter table messages add constraint messages_source_check
  check (source in ('web', 'hook', 'cron', 'whatsapp', 'delegation'));

create table delegations (
 id              bigint generated always as identity primary key,
 agent_id        bigint not null references agents on delete cascade,
 run_id          bigint references runs on delete set null,          -- the work that started it
 conversation_id bigint references conversations on delete set null, -- where its result goes
 number_id       bigint not null references whatsapp_numbers on delete cascade,
 phone           text not null check (phone ~ '^[0-9]{8,15}$'),
 contact         text not null,                                      -- the contact's name, as the owner sees it
 template        jsonb not null,                                     -- frozen when it started
 params          jsonb not null,
 status          text not null default 'active'
                 check (status in ('active', 'done', 'expired', 'cancelled', 'failed')),
 waiting         boolean not null default false,                     -- asked the agent something (escalated)
 data            jsonb,                                              -- what it has gathered so far
 summary         text,
 end_reason      text,
 thread_id       text,                                               -- Cuby: the thread it talks in
 sent            int not null default 0,                             -- messages it sent to the contact
 tokens          int not null default 0,
 deadline        timestamptz not null,
 created_at      timestamptz not null default now(),
 updated_at      timestamptz not null default now(),
 ended_at        timestamptz,
 reported_at     timestamptz                                         -- when its result reached the agent
);
-- One active encargo per phone of a number: anything that phone writes is for it, and for nothing else.
create unique index delegations_active_phone on delegations (number_id, phone) where status = 'active';
create index delegations_agent on delegations (agent_id, created_at desc);
create index delegations_run on delegations (run_id);

create table delegation_messages (
 id            bigint generated always as identity primary key,
 delegation_id bigint not null references delegations on delete cascade,
 role          text not null check (role in ('contact', 'delegate', 'agent', 'note')),
 text          text not null,
 files         jsonb,                                                -- names of the files it carried
 external_id   text,                                                 -- WhatsApp's id, against repeats
 processed_at  timestamptz,                                          -- contact/agent: when a turn read it
 at            timestamptz not null default now()
);
create unique index delegation_messages_external on delegation_messages (delegation_id, external_id)
  where external_id is not null;
create index delegation_messages_pending on delegation_messages (delegation_id) where processed_at is null;
