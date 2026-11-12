-- Conversaciones (Angel 11-nov-2026): every WhatsApp message between an agent and a person, in or out, by chat
-- (g: their group, d: a direct guest, e: an external contact and its encargos; the phone as in the lists), for
-- the agent's WhatsApp-like view. Simulated ones stay in whatsapp_sim_messages. Before this log only part was
-- kept: what people wrote, encargos whole, and the first lines of what agents said in groups; those rows are
-- rebuilt here as `backfilled` (the view says where the complete history starts).
create table whatsapp_log (
  id              bigint generated always as identity primary key,
  agent_id        bigint not null references agents on delete cascade,
  chat            text not null check (chat ~ '^[gde]:[0-9]{8,15}$'),
  direction       text not null check (direction in ('in', 'out')),
  author          text not null,
  text            text not null default '',
  files           jsonb,                                              -- names of the files it carried
  conversation_id bigint references conversations on delete set null, -- the trabajo it belongs to
  delegation_id   bigint references delegations on delete set null,   -- the encargo it belongs to
  ref             text,                                               -- WhatsApp's id of what came in, against repeats
  backfilled      boolean not null default false,
  at              timestamptz not null default now()
);
create index whatsapp_log_chat on whatsapp_log (agent_id, chat, id);
create index whatsapp_log_conversation on whatsapp_log (conversation_id);
create unique index whatsapp_log_ref on whatsapp_log (agent_id, chat, ref) where ref is not null;

-- The simulator's lines also say their trabajo (a view of a trabajo lists its chats).
alter table whatsapp_sim_messages add column conversation_id bigint references conversations on delete set null;
update whatsapp_sim_messages s set conversation_id = d.conversation_id from delegations d where d.id = s.delegation_id;
update whatsapp_sim_messages s set conversation_id = c.conversation_id
  from whatsapp_sim_chats c where s.conversation_id is null and c.agent_id = s.agent_id and c.chat = s.chat;

-- What people wrote (their messages to the agent; the simulator's are not real).
insert into whatsapp_log (agent_id, chat, direction, author, text, conversation_id, backfilled, at)
select m.agent_id, x.chat, 'in',
       case when m.sender like '+%' or m.sender is null then '+' || x.phone else split_part(m.sender, ' (+', 1) end,
       regexp_replace(m.text, '^\(En respuesta a tu mensaje: «.*?»\)\n\n', ''),
       m.conversation_id, true, m.received_at
from messages m
cross join lateral (select regexp_replace(coalesce(m.context -> 'whatsapp' ->> 'phone', ''), '\D', '', 'g') as raw) r
cross join lateral (select case when r.raw ~ '^521\d{10}$' then '52' || substr(r.raw, 4) else r.raw end as phone) p
left join whatsapp_groups g on g.id = (m.context -> 'whatsapp' ->> 'group')::bigint
cross join lateral (
  select p.phone,
         case when m.context -> 'whatsapp' ? 'group' then 'g:' || g.phone
              when m.context -> 'whatsapp' ? 'external' then 'e:' || p.phone
              when m.context -> 'whatsapp' ->> 'direct' = 'true' then 'd:' || p.phone end as chat
) x
where m.source = 'whatsapp' and m.context ? 'whatsapp' and not (m.context -> 'whatsapp' ? 'sim')
  and x.chat ~ '^[gde]:[0-9]{8,15}$';

-- What agents said in groups: its first 500 characters, once per message (a long one went in several).
insert into whatsapp_log (agent_id, chat, direction, author, text, conversation_id, backfilled, at)
select distinct on (o.agent_id, o.group_id, o.text, date_trunc('second', o.at))
       o.agent_id, 'g:' || g.phone, 'out', a.name, o.text, o.conversation_id, true, o.at
from whatsapp_outbound o join whatsapp_groups g on g.id = o.group_id join agents a on a.id = o.agent_id
where o.agent_id is not null
order by o.agent_id, o.group_id, o.text, date_trunc('second', o.at), o.at;

-- Encargos, whole: what the encargo said and what the contact answered.
insert into whatsapp_log (agent_id, chat, direction, author, text, files, conversation_id, delegation_id, backfilled, at)
select d.agent_id, 'e:' || d.phone, case when dm.role = 'contact' then 'in' else 'out' end,
       case when dm.role = 'contact' then d.contact else 'Encargo' end,
       dm.text, dm.files, d.conversation_id, d.id, true, dm.at
from delegation_messages dm join delegations d on d.id = dm.delegation_id
where not d.simulated and dm.role in ('contact', 'delegate');
