-- A group reopened (its agents came back) whose member Agents could not put back in, because WhatsApp refused
-- (left_recently, …): `reopen`, retried every 10 minutes like `list`. Before, it kept the `self` Cuby had said
-- when the group closed, which is never retried, so the member stayed out for good (Miguel, 27-nov-2026).
alter table whatsapp_groups drop constraint whatsapp_groups_member_out_check;
alter table whatsapp_groups add constraint whatsapp_groups_member_out_check
	check (member_out in ('list', 'integration', 'self', 'reopen'));

-- The ones already stuck that way: out as `self`, with the error only a failed put-back writes.
update whatsapp_groups set member_out = 'reopen'
	where member_out = 'self' and status = 'open' and error like 'No se pudo meter al grupo%';
