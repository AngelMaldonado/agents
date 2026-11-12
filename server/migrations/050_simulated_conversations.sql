-- Conversaciones simuladas (Angel 9-nov-2026): a switch per agent, off by default. While on, what it says to a
-- member's group, a direct guest or an external contact (its encargos included) is kept here instead of sent,
-- and its owner answers as that person from the web simulator. What it tells its owner stays real. What comes
-- in that way follows the same paths as a real message, in conversations and encargos of its own (marked
-- simulated), so a real message never lands in a simulated one, nor a simulated one goes out.
alter table agents add column simulated_conversations boolean not null default false;
alter table delegations add column simulated boolean not null default false;

-- One line of a simulated chat. chat: g:owner | g:<phone> (a person's group «Agentes …»), d:<phone> (a direct
-- guest), e:<phone> (an external contact). out: the agent (or its encargo) wrote it; in: the simulated person.
create table whatsapp_sim_messages (
  id bigserial primary key,
  agent_id bigint not null references agents on delete cascade,
  chat text not null check (chat ~ '^(g:owner|g:[0-9]{8,15}|d:[0-9]{8,15}|e:[0-9]{8,15})$'),
  direction text not null check (direction in ('in', 'out')),
  author text not null,
  text text not null,
  files jsonb,
  delegation_id bigint references delegations on delete set null,
  created_at timestamptz not null default now()
);
create index whatsapp_sim_messages_chat on whatsapp_sim_messages (agent_id, chat, id);

-- Where a simulated chat's next message goes: the conversation the agent last spoke from to it.
create table whatsapp_sim_chats (
  agent_id bigint not null references agents on delete cascade,
  chat text not null,
  conversation_id bigint references conversations on delete set null,
  updated_at timestamptz not null default now(),
  primary key (agent_id, chat)
);
