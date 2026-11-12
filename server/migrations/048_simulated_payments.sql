-- Pagos simulados (Angel 6-nov-2026): a switch per agent, off by default, that replaces the simulation of
-- each list of tasks. While on, every turn of the agent runs its browser with clicks to pay intercepted and
-- payment requests blocked, and it sees a confirmation as if it had paid: the test is realistic for it and
-- for whoever it talks to. Only the run's activity and the list's history say what was simulated.
alter table agents add column simulated_payments boolean not null default false;
alter table flows drop column simulation;
