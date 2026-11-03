-- Each WhatsApp chat with an agent is its own conversation (#18): what each phone asked stays apart,
-- with its own pi context, instead of everyone writing into Principal. The key is '<number id>:<phone>'.
alter table conversations add column whatsapp_key text;
create unique index conversations_whatsapp on conversations (agent_id, whatsapp_key)
 where whatsapp_key is not null and archived_at is null and deleted_at is null;
