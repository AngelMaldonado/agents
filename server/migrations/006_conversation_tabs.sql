-- Conversations are durable pi contexts, not browser lifetimes. Closing a tab never cancels work.
alter table conversations add column title text;
alter table conversations add column client_key uuid;
create unique index conversations_client_key on conversations(agent_id,client_key);
alter table conversations add column is_default boolean not null default false;
update conversations set is_default=true where archived_at is null;
drop index conversations_current;
-- The default for hooks/cron stays independent of whichever tab the UI has selected or closed.
create unique index conversations_default on conversations(agent_id) where is_default;
insert into conversations(agent_id,pi_session_id,is_default)
 select a.id,gen_random_uuid()::text,true from agents a
 where not exists(select 1 from conversations c where c.agent_id=a.id and c.is_default);
alter table messages add column conversation_id bigint references conversations;
update messages m set conversation_id=r.conversation_id from runs r where r.id=m.run_id;
update messages m set conversation_id=c.id from conversations c
 where m.conversation_id is null and c.agent_id=m.agent_id and c.is_default;
alter table messages alter column conversation_id set not null;
create index messages_conversation on messages(conversation_id,id);
create index runs_conversation on runs(conversation_id,id desc);
alter table conversations add constraint conversations_agent_identity unique(agent_id,id);
alter table runs add constraint runs_conversation_owner foreign key(agent_id,conversation_id) references conversations(agent_id,id);
alter table messages add constraint messages_conversation_owner foreign key(agent_id,conversation_id) references conversations(agent_id,id);
