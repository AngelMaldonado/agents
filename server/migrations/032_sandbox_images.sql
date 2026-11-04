-- Docker's local image ID is not the registry manifest digest. Keep version metadata even after prune.
create table sandbox_images (
    image_id text primary key check (image_id ~ '^sha256:[a-f0-9]{64}$'),
    version text,
    pi_version text,
    seen_at timestamptz not null default now()
);
