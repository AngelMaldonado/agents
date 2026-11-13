-- Trabajos: one with nobody's name (a schedule, a webhook, a guest's chat) is its agent's owner's, so the
-- next trabajos of the owner know it.
update conversations c set person_id = a.person_id from agents a
 where a.id = c.agent_id and c.person_id is null and not c.is_default;
