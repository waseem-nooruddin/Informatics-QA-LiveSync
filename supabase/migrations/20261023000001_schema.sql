-- QA LiveSync — core schema (SRS §6.1, MP-04).
-- Every project-owned row carries project_id; composite FKs (project_id, …) make
-- cross-project references impossible at the database level (MP-FR-019/020).

create extension if not exists pgcrypto with schema extensions;

-- ── Projects ──────────────────────────────────────────────────────────────────
create table public.projects (
  id                  text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name                text not null check (length(trim(name)) between 1 and 120),
  created_at          timestamptz not null default now(),
  archived_at         timestamptz,
  current_snapshot_id uuid,
  current_version     bigint not null default 0,
  last_verified_at    timestamptz,
  mapping_version     integer not null default 1,
  ruleset_version     text not null default 'v0-provisional'
);

create function public.forbid_project_id_change() returns trigger language plpgsql as $$
begin
  if new.id <> old.id then raise exception 'project id is immutable'; end if;
  return new;
end $$;
create trigger projects_id_immutable before update on public.projects
  for each row execute function public.forbid_project_id_change();

-- Per-project, versioned business rules (MP-FR-031). Ruleset JSON overrides core DEFAULT_RULESET.
create table public.ruleset_versions (
  project_id  text not null references public.projects(id) on delete restrict,
  version     text not null,
  ruleset     jsonb not null default '{}',
  provisional boolean not null default true,
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  primary key (project_id, version)
);

create table public.project_settings (
  project_id             text primary key references public.projects(id) on delete restrict,
  stale_threshold_minutes integer not null default 15 check (stale_threshold_minutes between 1 and 1440),
  export_settings        jsonb not null default '{"csv": true, "pdf": true}',
  explicit_columns       jsonb not null default '{}',
  updated_at             timestamptz not null default now()
);

-- Public-safe live status row per project (Realtime-published).
create table public.project_state (
  project_id      text primary key references public.projects(id) on delete restrict,
  run_id          uuid,
  run_state       text not null default 'Pending'
                  check (run_state in ('Pending','Validating','Validated','Validation Failed','Sync Failed')),
  gate_progress   jsonb not null default '[]',
  source_health   jsonb not null default '{"total":0,"healthy":0,"failing":0}',
  last_attempt_at timestamptz,
  last_failure_at timestamptz,
  last_error      text,
  snapshot_id     uuid,
  snapshot_version bigint,
  last_verified_at timestamptz,
  lease_run_id    uuid,
  lease_until     timestamptz,
  updated_at      timestamptz not null default now()
);

-- ── Sources ───────────────────────────────────────────────────────────────────
create table public.source_credentials (
  id               uuid primary key default gen_random_uuid(),
  project_id       text not null references public.projects(id) on delete restrict,
  provider         text not null check (provider in ('google','microsoft')),
  account_ref      text not null,
  vault_secret_id  uuid not null,
  scopes           text[] not null default '{}',
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  unique (project_id, id)
);

create table public.source_connections (
  id            uuid not null default gen_random_uuid(),
  project_id    text not null references public.projects(id) on delete restrict,
  provider      text not null check (provider in ('google-sheets','google-drive-xlsx','google-drive-folder','onedrive','onedrive-folder','upload')),
  external_id   text not null,
  display_name  text not null,
  credential_id uuid,
  state         text not null default 'active' check (state in ('active','disabled','removed')),
  storage_path  text,
  created_at    timestamptz not null default now(),
  created_by    text,
  primary key (project_id, id),
  unique (id),
  unique (project_id, provider, external_id),
  foreign key (project_id, credential_id) references public.source_credentials(project_id, id)
);

-- MP-FR-018: one source → one project unless an explicit, auditable exception exists.
create table public.source_project_exceptions (
  provider     text not null,
  external_id  text not null,
  project_id   text not null references public.projects(id) on delete restrict,
  reason       text not null,
  approved_by  text not null,
  created_at   timestamptz not null default now(),
  primary key (provider, external_id, project_id)
);

create function public.enforce_single_project_source() returns trigger language plpgsql as $$
begin
  if new.provider = 'upload' then return new; end if;
  if exists (
    select 1 from public.source_connections c
    where c.provider = new.provider and c.external_id = new.external_id
      and c.project_id <> new.project_id and c.state <> 'removed'
  ) and not exists (
    select 1 from public.source_project_exceptions e
    where e.provider = new.provider and e.external_id = new.external_id and e.project_id = new.project_id
  ) then
    raise exception 'SOURCE_IN_OTHER_PROJECT: source is already connected to another project' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger source_single_project before insert on public.source_connections
  for each row execute function public.enforce_single_project_source();

-- Files discovered under a connection (a direct file is its own single document).
create table public.source_documents (
  project_id      text not null,
  connection_id   uuid not null,
  file_id         text not null,
  display_name    text not null,
  file_type       text,
  parent_ref      text,
  revision        text,
  modified_at     timestamptz,
  last_read_at    timestamptz,
  last_success_at timestamptz,
  health          text not null default 'unknown' check (health in ('unknown','healthy','failing','missing','unsupported')),
  health_detail   text,
  primary key (project_id, file_id),
  foreign key (project_id, connection_id) references public.source_connections(project_id, id)
);

create table public.source_worksheets (
  project_id   text not null,
  file_id      text not null,
  sheet_id     text not null,
  title        text not null,
  kind         text not null check (kind in ('module','defects','skipped')),
  reason       text,
  last_seen_at timestamptz not null default now(),
  primary key (project_id, file_id, sheet_id),
  foreign key (project_id, file_id) references public.source_documents(project_id, file_id)
);

-- Cached normalized workbook contents per revision (FR-SYNC-004: reuse unchanged revisions).
create table public.source_cache (
  project_id text not null,
  file_id    text not null,
  revision   text not null,
  sheets     jsonb not null,
  cached_at  timestamptz not null default now(),
  primary key (project_id, file_id),
  foreign key (project_id, file_id) references public.source_documents(project_id, file_id)
);

-- ── Modules ───────────────────────────────────────────────────────────────────
create table public.modules (
  project_id  text not null references public.projects(id) on delete restrict,
  id          text not null check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  primary key (project_id, id)
);

create table public.module_mappings (
  project_id  text not null,
  file_id     text not null,
  sheet_id    text not null,
  module_id   text not null,
  source_id   text not null,
  sheet_title text not null,
  created_at  timestamptz not null default now(),
  primary key (project_id, file_id, sheet_id),
  foreign key (project_id, module_id) references public.modules(project_id, id)
);

create function public.bump_mapping_version() returns trigger language plpgsql as $$
declare pid text := coalesce(new.project_id, old.project_id);
begin
  update public.projects set mapping_version = mapping_version + 1 where id = pid;
  return null;
end $$;
create trigger module_mappings_version after insert or delete or update of module_id on public.module_mappings
  for each row execute function public.bump_mapping_version();

-- ── Runs, canonical records, validation, snapshots ────────────────────────────
create sequence public.sync_run_version_seq;

create table public.sync_runs (
  id              uuid not null default gen_random_uuid(),
  project_id      text not null references public.projects(id) on delete restrict,
  version         bigint not null default nextval('public.sync_run_version_seq'),
  trigger         text not null check (trigger in ('schedule','manual','change-event','source-added')),
  state           text not null default 'Pending'
                  check (state in ('Pending','Validating','Validated','Validation Failed','Sync Failed','No Change','Superseded')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  source_outcomes jsonb not null default '[]',
  fingerprint     text,
  error_codes     text[] not null default '{}',
  primary key (project_id, id),
  unique (id)
);
create index sync_runs_project_started on public.sync_runs (project_id, started_at desc);

create table public.canonical_tests (
  project_id   text not null,
  run_id       uuid not null,
  module_id    text not null,
  test_case_id text not null,
  status       text not null check (status in ('Passed','Failed','Blocked','Not Tested')),
  executed_at  timestamptz,
  lineage      jsonb not null,
  executions   integer not null default 1,
  primary key (project_id, run_id, module_id, test_case_id),
  foreign key (project_id, run_id) references public.sync_runs(project_id, id) on delete cascade,
  foreign key (project_id, module_id) references public.modules(project_id, id)
);

create table public.canonical_defects (
  project_id text not null,
  run_id     uuid not null,
  defect_id  text not null,
  module_id  text not null,
  lifecycle  text not null check (lifecycle in ('Open','Closed')),
  raw_status text not null,
  severity   text,
  priority   text,
  lineage    jsonb not null,
  primary key (project_id, run_id, defect_id),
  foreign key (project_id, run_id) references public.sync_runs(project_id, id) on delete cascade,
  foreign key (project_id, module_id) references public.modules(project_id, id)
);

create table public.validation_results (
  project_id      text not null,
  run_id          uuid not null,
  gates           jsonb not null,
  publishable     boolean not null,
  run_state       text not null,
  counts          jsonb not null,
  issues          jsonb not null default '[]',
  decisions       jsonb not null default '[]',
  conflicts       jsonb not null default '[]',
  ruleset_version text not null,
  mapping_version text not null,
  created_at      timestamptz not null default now(),
  primary key (project_id, run_id),
  foreign key (project_id, run_id) references public.sync_runs(project_id, id) on delete cascade
);

create table public.snapshots (
  id              uuid not null default gen_random_uuid(),
  project_id      text not null references public.projects(id) on delete restrict,
  run_id          uuid not null,
  version         bigint not null,
  published_at    timestamptz not null default now(),
  source_cutoff   timestamptz not null,
  ruleset_version text not null,
  ruleset_provisional boolean not null,
  mapping_version text not null,
  payload         jsonb not null,          -- full, incl. source lineage (restricted)
  public_payload  jsonb not null,          -- aggregate-only (Option A)
  validation      jsonb not null,
  primary key (project_id, id),
  unique (id),
  unique (project_id, version),
  foreign key (project_id, run_id) references public.sync_runs(project_id, id)
);

alter table public.projects
  add constraint projects_current_snapshot_fk foreign key (id, current_snapshot_id)
  references public.snapshots(project_id, id) deferrable initially deferred;

-- Snapshots are immutable (FR-AUD-002); only the retention routine may delete.
create function public.snapshots_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('qals.retention', true) = 'on' then return old; end if;
  raise exception 'snapshots are immutable';
end $$;
create trigger snapshots_no_update before update or delete on public.snapshots
  for each row execute function public.snapshots_immutable();

create table public.audit_log (
  id         bigint generated always as identity primary key,
  project_id text references public.projects(id) on delete restrict,
  at         timestamptz not null default now(),
  actor      text not null,
  action     text not null,
  detail     jsonb not null default '{}'
);
create index audit_log_project_at on public.audit_log (project_id, at desc);

-- Admin keys (no login page; backend-enforced authorization, SEC-003/006).
create table public.admin_keys (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  key_hash   text not null unique,
  scope      text not null default 'platform',  -- 'platform' or a project id
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
