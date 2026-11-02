-- The person's accesses the designer suggests for the agent (#26): names and why, granted by the owner.
alter table agent_designs add column if not exists suggested_accesses jsonb not null default '[]'::jsonb;
