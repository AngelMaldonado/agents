-- Modo objetivo de los trabajos (Angel 10-nov-2026, after Claude Code's /goal, Codex's goals and pi-goal): the
-- platform, not the agent, keeps a trabajo with a list going. After each turn it continues it right away
-- unless something live will wake it (a wait, a question, an encargo); turns without progress stall it; an
-- independent auditor checks job_done against its objective; and a budget per trabajo caps its autonomy.
alter table conversations add column budget_usd numeric(8, 2) not null default 5 check (budget_usd > 0);
alter table conversations add column budget_turns integer not null default 40 check (budget_turns between 1 and 500);
-- Its autonomous turns in a row that changed nothing in its list.
alter table conversations add column idle_turns integer not null default 0;
-- How many times the auditor said its job_done was not yet met.
alter table conversations add column audit_rejections integer not null default 0;
-- When its owner heard it reached its budget (once, until it is raised).
alter table conversations add column budget_noticed_at timestamptz;
