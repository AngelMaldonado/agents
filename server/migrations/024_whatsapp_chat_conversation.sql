-- Who wrote last to a chat is who the next message goes to (#18): an agent that sends something there
-- (its answer, a question, a scheduled report, a notice) becomes the chat's awake agent. When it wrote to
-- its owner from another conversation (a schedule's Principal), the owner's reply goes to that one, where
-- the agent has what it asked; /agente, /agentes, /terminar or falling asleep go back to the chat's own.
alter table whatsapp_chats add column conversation_id bigint references conversations on delete set null;
