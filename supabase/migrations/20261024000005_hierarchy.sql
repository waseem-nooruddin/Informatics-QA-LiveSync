-- SRS V1.5: Project → Main Module → Submodule hierarchy, Google Drive project roots,
-- mapping review (quarantine) queue and versioned approval records.
-- Existing `modules` rows become submodules of a per-project "General" main module.

create table public.main_modules (
  project_id      text not null references public.projects(id) on delete restrict,
  id              text not null check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name            text not null check (length(trim(name)) between 1 and 120),
  drive_folder_id text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz,
  primary key (project_id, id)
);
create unique index main_modules_folder_unique on public.main_modules (project_id, drive_folder_id) where drive_folder_id is not null;

insert into public.main_modules (project_id, id, name)
select distinct project_id, 'general', 'General' from public.modules
on conflict do nothing;

-- Submodules (the existing modules table) gain their parent.
alter table public.modules add column main_module_id text;
update public.modules set main_module_id = 'general' where main_module_id is null;
alter table public.modules alter column main_module_id set not null;
alter table public.modules add constraint modules_main_module_fk
  foreign key (project_id, main_module_id) references public.main_modules(project_id, id);
alter table public.modules add constraint modules_project_main_id_unique unique (project_id, main_module_id, id);

alter table public.module_mappings add column main_module_id text;
update public.module_mappings mm set main_module_id = m.main_module_id from public.modules m where m.project_id = mm.project_id and m.id = mm.module_id;
alter table public.module_mappings alter column main_module_id set not null;
alter table public.module_mappings drop constraint module_mappings_project_id_module_id_fkey;
alter table public.module_mappings add constraint module_mappings_submodule_fk
  foreign key (project_id, main_module_id, module_id) references public.modules(project_id, main_module_id, id);

-- A source is attached to one main module (null = a project-root folder connection).
alter table public.source_connections add column main_module_id text;
alter table public.source_connections add constraint source_connections_main_module_fk
  foreign key (project_id, main_module_id) references public.main_modules(project_id, id);

alter table public.canonical_tests add column main_module_id text;
update public.canonical_tests t set main_module_id = m.main_module_id from public.modules m where m.project_id = t.project_id and m.id = t.module_id;
alter table public.canonical_tests alter column main_module_id set not null;
alter table public.canonical_tests drop constraint canonical_tests_project_id_module_id_fkey;
alter table public.canonical_tests add constraint canonical_tests_submodule_fk
  foreign key (project_id, main_module_id, module_id) references public.modules(project_id, main_module_id, id);

alter table public.canonical_defects add column main_module_id text;
update public.canonical_defects d set main_module_id = m.main_module_id from public.modules m where m.project_id = d.project_id and m.id = d.module_id;
alter table public.canonical_defects alter column main_module_id set not null;
alter table public.canonical_defects drop constraint canonical_defects_project_id_module_id_fkey;
alter table public.canonical_defects add constraint canonical_defects_submodule_fk
  foreign key (project_id, main_module_id, module_id) references public.modules(project_id, main_module_id, id);

-- The Google Drive folder chosen with "+ Add New Project" (FR-GD-001/002).
create table public.project_roots (
  project_id    text primary key references public.projects(id) on delete restrict,
  provider      text not null default 'google',
  folder_id     text not null,
  folder_name   text not null,
  account_ref   text,
  credential_id uuid,
  created_at    timestamptz not null default now(),
  foreign key (project_id, credential_id) references public.source_credentials(project_id, id)
);
-- One Drive folder roots one project unless an explicit, audited exception exists (V1.5 §2 rule d).
create unique index project_roots_folder_unique on public.project_roots (provider, folder_id);

-- Ambiguous discovery outcomes awaiting an administrator (V1.5 §5.2, AT-10).
create table public.mapping_reviews (
  id                  uuid primary key default gen_random_uuid(),
  project_id          text not null references public.projects(id) on delete restrict,
  key                 text not null,
  kind                text not null check (kind in ('submodule-name-collision', 'unknown-main-module', 'unknown-folder')),
  main_module_id      text,
  file_id             text,
  sheet_id            text,
  title               text not null,
  detail              text not null,
  candidate_module_id text,
  status              text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  resolution          jsonb,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         text,
  unique (project_id, key)
);

-- Versioned approvals (V1.5 §4 Phases 2–3; ApprovalRecord entity §6.2).
create table public.approval_records (
  id          uuid primary key default gen_random_uuid(),
  project_id  text references public.projects(id) on delete restrict,
  kind        text not null check (kind in ('ui', 'calculation', 'ruleset', 'mapping')),
  version     text not null,
  decision    text not null check (decision in ('YES', 'NO')),
  approved_by text not null,
  approved_at timestamptz not null default now(),
  details     jsonb not null default '{}'
);
insert into public.approval_records (kind, version, decision, approved_by, approved_at, details) values
  ('ui', 'ui-v1', 'YES', 'Project owner', '2026-10-24T00:00:00Z', '{"record":"docs/approvals/ui-v1.md","animations":true,"logo":"pending file"}'),
  ('calculation', 'calc-v1', 'YES', 'Project owner', '2026-10-24T00:00:00Z', '{"record":"docs/approvals/calc-v1.md","ruleset":"v1"}');

do $$
declare t text;
begin
  foreach t in array array['main_modules', 'project_roots', 'mapping_reviews', 'approval_records'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- New projects start on the approved ruleset v1.
alter table public.projects alter column ruleset_version set default 'v1';

create or replace function public.create_project(p_id text, p_name text, p_actor text)
returns public.projects language plpgsql security definer set search_path = public as $$
declare r public.projects;
begin
  insert into projects (id, name, ruleset_version) values (lower(trim(p_id)), trim(p_name), 'v1') returning * into r;
  insert into project_settings (project_id) values (r.id);
  insert into project_state (project_id) values (r.id);
  insert into ruleset_versions (project_id, version, ruleset, provisional, approved_by, approved_at)
  values (r.id, 'v1', '{}', false, 'Project owner (calc-v1)', '2026-10-24T00:00:00Z');
  insert into audit_log (project_id, actor, action, detail) values (r.id, p_actor, 'project.created', jsonb_build_object('name', r.name));
  return r;
exception when unique_violation then
  raise exception 'PROJECT_EXISTS: project id "%" already exists', p_id using errcode = 'P0001';
end $$;
revoke execute on function public.create_project(text, text, text) from anon, authenticated, public;
grant execute on function public.create_project(text, text, text) to service_role;

-- Public navigation tree taken ONLY from the published snapshot (validated entries only).
drop view if exists public.v_published_modules;
create view public.v_published_hierarchy with (security_barrier) as
select p.id as project_id,
       mm->>'mainModuleId' as main_module_id,
       mm->>'name' as main_module_name,
       sm->>'id' as submodule_id,
       sm->>'name' as submodule_name
from public.projects p
join public.snapshots sn on sn.project_id = p.id and sn.id = p.current_snapshot_id
cross join lateral jsonb_array_elements(sn.public_payload->'hierarchy') mm
left join lateral jsonb_array_elements(mm->'submodules') sm on true;
grant select on public.v_published_hierarchy to anon, authenticated;

create or replace view public.v_project_directory with (security_barrier) as
select
  p.id                 as project_id,
  p.name,
  p.archived_at,
  p.created_at,
  p.current_snapshot_id as snapshot_id,
  p.last_verified_at,
  coalesce(s.stale_threshold_minutes, 15) as stale_threshold_minutes,
  (select count(*) from public.modules m join public.main_modules mm on mm.project_id = m.project_id and mm.id = m.main_module_id
     where m.project_id = p.id and m.active and mm.active) as module_count,
  (select count(*) from public.source_connections c where c.project_id = p.id and c.state = 'active') as source_count,
  st.run_state,
  st.last_attempt_at,
  st.last_failure_at,
  (select count(*) from public.main_modules mm where mm.project_id = p.id and mm.active) as main_module_count
from public.projects p
left join public.project_settings s on s.project_id = p.id
left join public.project_state st on st.project_id = p.id;
grant select on public.v_project_directory to anon, authenticated;

-- ── Platform-level Google account for "+ Add New Project" (before a project exists) ──
-- A platform credential (project_id null) is CLONED into each new project, so every project
-- still owns its own encrypted token (isolation, V1.5 §6.1).
alter table public.source_credentials alter column project_id drop not null;

create or replace function public.store_credential(
  p_project text, p_provider text, p_account text, p_secret jsonb, p_scopes text[])
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_secret uuid; v_id uuid;
begin
  v_secret := vault.create_secret(p_secret::text, 'qals-cred-' || gen_random_uuid()::text, 'QA LiveSync OAuth credential');
  insert into source_credentials (project_id, provider, account_ref, vault_secret_id, scopes)
  values (p_project, p_provider, p_account, v_secret, p_scopes) returning id into v_id;
  insert into audit_log (project_id, actor, action, detail)
  values (p_project, 'admin', 'credential.stored', jsonb_build_object('credentialId', v_id, 'provider', p_provider, 'account', p_account));
  return v_id;
end $$;

create or replace function public.read_credential(p_project text, p_id uuid)
returns jsonb language sql stable security definer set search_path = public, vault as $$
  select ds.decrypted_secret::jsonb
  from source_credentials c join vault.decrypted_secrets ds on ds.id = c.vault_secret_id
  where c.id = p_id and c.revoked_at is null and c.project_id is not distinct from p_project;
$$;

create or replace function public.update_credential(p_project text, p_id uuid, p_secret jsonb)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_secret uuid;
begin
  select vault_secret_id into v_secret from source_credentials
   where id = p_id and revoked_at is null and project_id is not distinct from p_project;
  if v_secret is null then raise exception 'CREDENTIAL_NOT_FOUND' using errcode = 'P0001'; end if;
  perform vault.update_secret(v_secret, p_secret::text);
end $$;

create function public.clone_credential(p_id uuid, p_project text)
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_src source_credentials; v_secret jsonb;
begin
  select * into v_src from source_credentials where id = p_id and project_id is null and revoked_at is null;
  if v_src.id is null then raise exception 'CREDENTIAL_NOT_FOUND' using errcode = 'P0001'; end if;
  select decrypted_secret::jsonb into v_secret from vault.decrypted_secrets where id = v_src.vault_secret_id;
  return store_credential(p_project, v_src.provider, v_src.account_ref, v_secret, v_src.scopes);
end $$;

revoke execute on function public.store_credential(text, text, text, jsonb, text[]) from anon, authenticated, public;
revoke execute on function public.read_credential(text, uuid) from anon, authenticated, public;
revoke execute on function public.update_credential(text, uuid, jsonb) from anon, authenticated, public;
revoke execute on function public.clone_credential(uuid, text) from anon, authenticated, public;
grant execute on function public.store_credential(text, text, text, jsonb, text[]) to service_role;
grant execute on function public.read_credential(text, uuid) to service_role;
grant execute on function public.update_credential(text, uuid, jsonb) to service_role;
grant execute on function public.clone_credential(uuid, text) to service_role;

-- ── Follow-up runs: a change that arrives while a sync holds the lease is not dropped ──
alter table public.project_state add column rerun_requested boolean not null default false;

create or replace function public.acquire_sync_lease(p_project text, p_run uuid, p_seconds integer default 600)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update project_state
     set lease_run_id = p_run, lease_until = now() + make_interval(secs => p_seconds),
         run_id = p_run, run_state = 'Validating', last_attempt_at = now(), rerun_requested = false, updated_at = now()
   where project_id = p_project and (lease_until is null or lease_until < now() or lease_run_id = p_run)
  returning true into ok;
  if ok is null then
    update project_state set rerun_requested = true where project_id = p_project;
  end if;
  return coalesce(ok, false);
end $$;

drop function public.release_sync_lease(text, uuid);
create function public.release_sync_lease(p_project text, p_run uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare rerun boolean;
begin
  update project_state set lease_run_id = null, lease_until = null, updated_at = now()
   where project_id = p_project and lease_run_id = p_run
  returning rerun_requested into rerun;
  return coalesce(rerun, false);
end $$;
revoke execute on function public.acquire_sync_lease(text, uuid, integer) from anon, authenticated, public;
revoke execute on function public.release_sync_lease(text, uuid) from anon, authenticated, public;
grant execute on function public.acquire_sync_lease(text, uuid, integer) to service_role;
grant execute on function public.release_sync_lease(text, uuid) to service_role;
