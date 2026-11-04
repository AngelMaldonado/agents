-- Preserve the identity of dev images even after :dev moves and their tag disappears.
alter table sandbox_images
    add column development boolean not null default false,
    add column revision text,
    add column dirty boolean,
    add column pi_checked_at timestamptz;
