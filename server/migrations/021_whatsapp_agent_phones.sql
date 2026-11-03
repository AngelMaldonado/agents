-- Who writes to each agent by WhatsApp (#18), decided by the agent's owner in its Canales. By default the
-- owner and the people it is shared with (when their phone is linked to them in the number's allow list)
-- are on and the number's guests are off; a row here is the owner's explicit choice and wins. No foreign
-- key to whatsapp_phones: saving the lists rewrites them, and a choice outlives that.
create table whatsapp_agent_phones (
 agent_id   bigint not null references agents on delete cascade,
 number_id  bigint not null references whatsapp_numbers on delete cascade,
 phone      text not null check (phone ~ '^[0-9]{8,15}$'),
 enabled    boolean not null,
 updated_at timestamptz not null default now(),
 primary key (agent_id, number_id, phone)
);
