-- WhatsApp agents wake on purpose (#18): a chat talks to an agent only after /agentes (a poll) or
-- /agente <x>, and the agent falls asleep after sleep_minutes without messages (or /terminar). Until then
-- the number ignores that phone, so a linked personal number keeps its chats to itself.
alter table whatsapp_numbers add column sleep_minutes int not null default 30 check (sleep_minutes between 5 and 1440);
alter table whatsapp_chats add column awake_until timestamptz;            -- null: asleep
alter table whatsapp_chats add column poll_id text;                       -- the last /agentes poll sent
alter table whatsapp_chats add column poll_options jsonb;                 -- [{hash, agentId}] of that poll
