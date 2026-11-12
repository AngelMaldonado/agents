-- Encargos (#18, Angel 5-nov-2026): the agent can tell an encargo about its work when it starts it (used to
-- converse, shared with the contact only as its objective and rules allow), and give it files to send.
alter table delegations add column context text;
