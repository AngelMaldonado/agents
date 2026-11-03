-- Suppliers (#18, Angel 3-nov-2026): a guest of the number marked as a supplier never gets a group. An
-- agent whose owner switched them on writes to them one to one (whatsapp_notify), in a thread of its own,
-- and their answer (text, photos, the quote as a PDF) goes back to the conversation that asked.
alter table whatsapp_phones add column supplier boolean not null default false;

-- Each agent's chat with a supplier: which agent and conversation asked, and its Cuby thread (null on
-- Agents' own numbers, where the latest one of that phone answers).
create table whatsapp_supplier_threads (
 id              bigint generated always as identity primary key,
 number_id       bigint not null references whatsapp_numbers on delete cascade,
 phone           text not null check (phone ~ '^[0-9]{8,15}$'),
 agent_id        bigint not null references agents on delete cascade,
 conversation_id bigint references conversations on delete set null,
 thread_id       text,
 created_at      timestamptz not null default now(),
 last_at         timestamptz not null default now()
);
create index whatsapp_supplier_threads_phone on whatsapp_supplier_threads (number_id, phone, last_at desc);
create unique index whatsapp_supplier_threads_thread on whatsapp_supplier_threads (number_id, thread_id) where thread_id is not null;
