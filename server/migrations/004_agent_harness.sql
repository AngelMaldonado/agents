-- Legacy agents keep their existing effective capabilities; no conversation/profile rotation.
alter table agents add column if not exists harness jsonb not null default '{"version":1,"tools":["bash","browser","edit","login","read","request_help","write"],"restrictions":{"workspaceFilesOnly":false,"readOnlyFiles":false,"guidelines":[]},"skills":[],"plugins":[]}';
alter table agents add column if not exists harness_image text;
alter table agent_designs add column if not exists harness jsonb not null default '{"version":1,"tools":["bash","browser","edit","login","read","request_help","write"],"restrictions":{"workspaceFilesOnly":false,"readOnlyFiles":false,"guidelines":[]},"skills":[],"plugins":[]}';
alter table agent_designs add column if not exists harness_validation jsonb;
alter table agent_designs add column if not exists validation_pending boolean not null default false;
alter table runs add column if not exists definition jsonb;
create table if not exists agent_revisions (
 agent_id bigint not null references agents(id), revision integer not null,
 name text not null, role text not null, model text not null, harness jsonb not null,
 image text, created_at timestamptz not null default now(), primary key (agent_id, revision)
);
insert into agent_revisions (agent_id, revision, name, role, model, harness, image)
 select id, config_revision, name, role, model, harness, harness_image from agents
 on conflict do nothing;
-- An improvement already in progress inherits the real current harness, not a new default.
update agent_designs d set harness=a.harness from agents a where d.agent_id=a.id and d.status='draft';
