-- A 'browser' run: Chrome only, no LLM, driven by the agent's owner to sign in to sites and save
-- payment methods in the agent's browser profile.
alter table runs drop constraint runs_kind_check;
alter table runs add constraint runs_kind_check check (kind in ('task', 'initialize', 'browser'));
