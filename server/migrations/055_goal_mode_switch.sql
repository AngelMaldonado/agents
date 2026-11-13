-- Modo objetivo, a switch per agent (Angel 10-nov-2026), off by default. On, its trabajos go on by themselves
-- until their objective is met (continuation after each turn, turns without progress, a budget per trabajo, an
-- independent auditor on job_done). Its owner turns it on in Configuración, with /goal, or by approving it in
-- the designer's interview or in Automejora (the draft's goal_mode: null keeps the agent's).
alter table agents add column goal_mode boolean not null default false;
alter table agent_designs add column goal_mode boolean;
