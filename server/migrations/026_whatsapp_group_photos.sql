-- The photo of a person's groups «Agentes <person>» (#18, Angel 2-nov-2026): a square JPEG made in the
-- browser. A new group gets it; on Agents' own numbers the open ones are updated too (Cuby WhatsApp only
-- takes a photo when the group is created).
create table whatsapp_group_photos (
 owner_id   bigint primary key references people on delete cascade,
 jpeg       bytea not null,
 updated_at timestamptz not null default now()
);
-- Which version of its owner's photo each group shows (null: none set by Agents).
alter table whatsapp_groups add column photo_at timestamptz;
