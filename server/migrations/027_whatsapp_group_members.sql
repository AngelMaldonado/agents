-- Whether a group's member is out of it, and why (cuby-whatsapp's group.member_left: `list` when their
-- phone left the integration's list, `integration`, or `self` when they left). Agents puts them back when
-- the group is still theirs, except when they left on their own (#18, 2-nov-2026).
alter table whatsapp_groups add column member_out text check (member_out in ('list', 'integration', 'self'));
