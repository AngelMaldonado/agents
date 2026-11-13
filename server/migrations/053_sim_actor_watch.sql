-- The simulator's actor stays on through the trabajo (Angel 10-nov-2026): with nothing to answer now it does not
-- stop, it keeps listening. seen_id: the agent's last line it already considered (it does not ask the model about
-- it again); note: why it answered or kept quiet.
alter table whatsapp_sim_actors add column seen_id bigint;
alter table whatsapp_sim_actors add column note text;
