-- La IA responde por defecto (Angel 10-nov-2026): each simulated contact's actor starts on; the agent writing to
-- its chat turns it on (whatsapp-sim.arm), unless its owner turned it off. A trabajo that ended or the
-- simulation turned off now pause it without turning its switch off: the ones they turned off go back on.
alter table whatsapp_sim_actors alter column auto set default true;
update whatsapp_sim_actors set auto = true, stopped = null, replies = 0
 where not auto and (stopped is null or stopped in ('el trabajo terminó', 'las conversaciones simuladas están apagadas'));
