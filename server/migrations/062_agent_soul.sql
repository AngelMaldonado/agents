-- Estilo (Angel 13-nov-2026): how an agent sounds, its soul (shared/souls.ts). style: one of the presets
-- (null: «Cuby YOLO», every agent's by default); soul: what its owner wrote instead (null: its style's).
alter table agents add column style text, add column soul text;
