-- The schedules a design proposes; applied to the agent when the owner approves it.
-- null keeps the agent's current schedules; [] removes them all.
alter table agent_designs add column schedules jsonb;
