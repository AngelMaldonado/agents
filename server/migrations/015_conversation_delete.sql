-- «Eliminar» a conversation (Bubble agents #25): it leaves every view (lists, sidebar, search, routing)
-- but its messages, runs and files stay, like a retired agent.
alter table conversations add column deleted_at timestamptz;
