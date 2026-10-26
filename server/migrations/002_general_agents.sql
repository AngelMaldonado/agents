-- General agents (thread 4) and GPT only.

-- GPT only: no Anthropic keys, ever.
delete from provider_keys where provider <> 'openai';
alter table provider_keys drop constraint provider_keys_provider_check;
alter table provider_keys add constraint provider_keys_provider_check check (provider = 'openai');

-- The answer is the agent's last message (runs.answer) plus ~/work/out; result.json is gone.
alter table runs drop column result;

-- What to wipe from an agent's browser profile. The profile only lives while Chrome runs, so a
-- purge waits for the agent's next run (or is applied at once if one is live).
create table profile_purges (
  id              bigint generated always as identity primary key,
  agent_id        bigint not null references agents on delete cascade,
  origin          text,                              -- null = the whole profile
  credential_name text,                              -- the vault access whose loss asked for it
  person_id       bigint references people on delete set null,
  requested_at    timestamptz not null default now(),
  run_id          bigint references runs on delete set null,  -- the run that applied it
  done_at         timestamptz,
  ok              boolean,
  detail          text
);
create index profile_purges_pending on profile_purges (agent_id) where done_at is null;
