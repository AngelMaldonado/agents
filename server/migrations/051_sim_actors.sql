-- Actores del simulador (Angel 10-nov-2026): GPT plays one of the agent's contacts in its simulator. On «auto»,
-- it answers each time the agent (or its encargo) writes to that chat, until it judges the conversation done,
-- its encargo ends, it reaches its cap or its owner stops it.
create table whatsapp_sim_actors (
  agent_id bigint not null references agents on delete cascade,
  chat text not null,
  -- Who that person is and what they know (prices, schedules, how they talk); empty: a plausible one.
  persona text,
  -- What that person wants from the conversation (optional).
  goal text,
  auto boolean not null default false,
  replies integer not null default 0,
  max_replies integer not null default 20,
  -- Why it stopped: it judged the conversation done, its encargo ended, the cap, its owner.
  stopped text,
  updated_at timestamptz not null default now(),
  primary key (agent_id, chat)
);
