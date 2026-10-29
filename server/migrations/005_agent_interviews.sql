-- Only an explicit, unchanged historical restore skips the new-design interview.
-- Existing drafts must answer a real round; approved agents/runs remain untouched.
alter table agent_designs add column restored_revision integer check (restored_revision > 0);
