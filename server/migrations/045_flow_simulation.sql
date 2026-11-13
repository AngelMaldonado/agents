-- Simulación (Angel 5-nov-2026): a flow can run for real except what cannot be undone. Its agent's clicks
-- to pay or confirm a purchase are intercepted (they never reach the site) and recorded as simulated; its
-- encargos tell the contact it is a test; its deliveries are taken as done in their window.
alter table flows add column simulation boolean not null default false;
