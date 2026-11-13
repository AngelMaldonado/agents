-- Replies go back to the trabajo that wrote (Angel 10-nov-2026): when the agent writes to someone from an open
-- trabajo, their reply lands in that trabajo (its saga), not in a new one. Groups keep it in
-- whatsapp_groups.last_conversation_id and external contacts in whatsapp_external_threads; a direct guest's chat,
-- here. The simulator also says which of a person's lines its AI actor wrote.
alter table whatsapp_direct_chats add column conversation_id bigint references conversations on delete set null;
alter table whatsapp_sim_messages add column actor boolean not null default false;
