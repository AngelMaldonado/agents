-- Trabajos: a WhatsApp chat has one OPEN trabajo with an agent at a time; the ones that ended keep their
-- key (their history) and do not stop the next one from opening. Before, «open» was «not archived».
drop index conversations_whatsapp;
create unique index conversations_whatsapp on conversations (agent_id, whatsapp_key)
  where whatsapp_key is not null and status = 'open' and deleted_at is null;
