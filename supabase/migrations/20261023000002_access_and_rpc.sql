-- Access control (SEC-002/003, MP-FR-020/023) and server-side RPCs.
-- Deployment Option A: anon may read ONLY curated aggregate views and the
-- public-safe project_state row. All writes go through Edge Functions (service role).

do $$
declare t text;
begin
  foreach t in array array[
    'projects','ruleset_versions','project_settings','project_state','source_credentials',
    'source_connections','source_project_exceptions','source_documents','source_worksheets',
    'source_cache','modules','module_mappings','sync_runs','canonical_tests','canonical_defects',
    'validation_results','snapshots','audit_log','admin_keys']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- project_state is public-safe by construction (no file names, no row data) and is
-- the Realtime channel, which requires a SELECT policy for the subscriber.
grant select on public.project_state to anon, authenticated;
create policy project_state_public_read on public.project_state for select to anon, authenticated using (true);

-- ── Curated public views (run as owner; expose aggregates only) ──────────────
create view public.v_project_directory with (security_barrier) as
select
  p.id                 as project_id,
  p.name,
  p.archived_at,
  p.created_at,
  p.current_snapshot_id as snapshot_id,
  p.last_verified_at,
  coalesce(s.stale_threshold_minutes, 15) as stale_threshold_minutes,
  (select count(*) from public.modules m where m.project_id = p.id and m.active) as module_count,
  (select count(*) from public.source_connections c where c.project_id = p.id and c.state = 'active') as source_count,
  st.run_state,
  st.last_attempt_at,
  st.last_failure_at
from public.projects p
left join public.project_settings s on s.project_id = p.id
left join public.project_state st on st.project_id = p.id;

create view public.v_published_snapshot with (security_barrier) as
select
  sn.project_id,
  p.name as project_name,
  sn.id as snapshot_id,
  sn.version,
  sn.published_at,
  sn.source_cutoff,
  sn.ruleset_version,
  sn.ruleset_provisional,
  sn.mapping_version,
  sn.public_payload as payload,
  sn.validation
from public.projects p
join public.snapshots sn on sn.project_id = p.id and sn.id = p.current_snapshot_id;

-- Module navigation list taken from the published snapshot, so navigation never
-- shows modules that have not passed validation.
create view public.v_published_modules with (security_barrier) as
select p.id as project_id, m->>'moduleId' as module_id, m->>'moduleName' as name
from public.projects p
join public.snapshots sn on sn.project_id = p.id and sn.id = p.current_snapshot_id
cross join lateral jsonb_array_elements(sn.public_payload->'table'->'modules') m;

grant select on public.v_project_directory, public.v_published_snapshot, public.v_published_modules to anon, authenticated;

-- ── Project provisioning (MP-FR-003/004/005) ──────────────────────────────────
create function public.create_project(p_id text, p_name text, p_actor text)
returns public.projects language plpgsql security definer set search_path = public as $$
declare r public.projects;
begin
  insert into projects (id, name) values (lower(trim(p_id)), trim(p_name)) returning * into r;
  insert into project_settings (project_id) values (r.id);
  insert into project_state (project_id) values (r.id);
  insert into ruleset_versions (project_id, version, ruleset, provisional) values (r.id, 'v0-provisional', '{}', true);
  insert into audit_log (project_id, actor, action, detail) values (r.id, p_actor, 'project.created', jsonb_build_object('name', r.name));
  return r;
exception when unique_violation then
  raise exception 'PROJECT_EXISTS: project id "%" already exists', p_id using errcode = 'P0001';
end $$;

-- ── Per-project sync lease (FR-SYNC-006) ──────────────────────────────────────
create function public.acquire_sync_lease(p_project text, p_run uuid, p_seconds integer default 600)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update project_state
     set lease_run_id = p_run, lease_until = now() + make_interval(secs => p_seconds),
         run_id = p_run, run_state = 'Validating', last_attempt_at = now(), updated_at = now()
   where project_id = p_project and (lease_until is null or lease_until < now() or lease_run_id = p_run)
  returning true into ok;
  return coalesce(ok, false);
end $$;

create function public.release_sync_lease(p_project text, p_run uuid)
returns void language sql security definer set search_path = public as $$
  update project_state set lease_run_id = null, lease_until = null, updated_at = now()
   where project_id = p_project and lease_run_id = p_run;
$$;

-- Record a non-published outcome; the previous verified snapshot stays current (FR-VAL-004).
create function public.record_run_outcome(
  p_project text, p_run uuid, p_state text, p_gates jsonb, p_source_health jsonb, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update sync_runs set state = p_state, finished_at = now() where project_id = p_project and id = p_run;
  update project_state
     set run_state = case when p_state in ('No Change','Superseded') then
                       (case when (select current_snapshot_id from projects where id = p_project) is null then 'Pending' else 'Validated' end)
                     else p_state end,
         gate_progress = coalesce(p_gates, gate_progress),
         source_health = coalesce(p_source_health, source_health),
         last_failure_at = case when p_state in ('Validation Failed','Sync Failed') then now() else last_failure_at end,
         last_error = case when p_state in ('Validation Failed','Sync Failed') then p_error else null end,
         updated_at = now()
   where project_id = p_project and run_id = p_run;
end $$;

-- ── Atomic publication (FR-PUB-001/002, FR-SYNC-007, AT-015) ──────────────────
create function public.publish_snapshot(
  p_project text, p_run uuid, p_source_cutoff timestamptz, p_ruleset_version text,
  p_ruleset_provisional boolean, p_mapping_version text, p_payload jsonb, p_public_payload jsonb,
  p_validation jsonb, p_gates jsonb, p_source_health jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_version bigint;
  v_current bigint;
  v_id uuid;
begin
  select version into v_version from sync_runs where project_id = p_project and id = p_run;
  if v_version is null then raise exception 'RUN_NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from validation_results where project_id = p_project and run_id = p_run and publishable) then
    raise exception 'NOT_VALIDATED: run % has no passing validation result', p_run using errcode = 'P0001';
  end if;

  select current_version into v_current from projects where id = p_project for update;
  if v_version <= v_current then
    update sync_runs set state = 'Superseded', finished_at = now() where project_id = p_project and id = p_run;
    raise exception 'STALE_RUN: run version % <= published version %', v_version, v_current using errcode = 'P0001';
  end if;

  insert into snapshots (project_id, run_id, version, source_cutoff, ruleset_version, ruleset_provisional,
                         mapping_version, payload, public_payload, validation)
  values (p_project, p_run, v_version, p_source_cutoff, p_ruleset_version, p_ruleset_provisional,
          p_mapping_version, p_payload, p_public_payload || jsonb_build_object('projectId', p_project), p_validation)
  returning id into v_id;

  update projects set current_snapshot_id = v_id, current_version = v_version, last_verified_at = now()
   where id = p_project;
  update sync_runs set state = 'Validated', finished_at = now() where project_id = p_project and id = p_run;
  update project_state
     set run_state = 'Validated', gate_progress = p_gates, source_health = p_source_health,
         snapshot_id = v_id, snapshot_version = v_version, last_verified_at = now(),
         last_error = null, updated_at = now()
   where project_id = p_project;
  insert into audit_log (project_id, actor, action, detail)
  values (p_project, 'worker', 'snapshot.published', jsonb_build_object('snapshotId', v_id, 'version', v_version, 'runId', p_run));
  return v_id;
end $$;

-- ── Independent SQL reconciliation path (FR-VAL-006) ─────────────────────────
create function public.reconcile_counts(p_project text, p_run uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with t as (
    select ct.module_id, ct.status from canonical_tests ct
    join modules m on m.project_id = ct.project_id and m.id = ct.module_id and m.active
    where ct.project_id = p_project and ct.run_id = p_run
  ), d as (
    select cd.lifecycle from canonical_defects cd
    join modules m on m.project_id = cd.project_id and m.id = cd.module_id and m.active
    where cd.project_id = p_project and cd.run_id = p_run
  )
  select jsonb_build_object(
    'totalTc', (select count(*) from t),
    'byStatus', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from t group by status) s), '{}'),
    'open', (select count(*) from d where lifecycle = 'Open'),
    'closed', (select count(*) from d where lifecycle = 'Closed'),
    'uniqueDefects', (select count(*) from d),
    'perModuleTc', coalesce((select jsonb_object_agg(module_id, n) from (select module_id, count(*) n from t group by module_id) s), '{}')
  );
$$;

-- ── Retention (FR-PUB-003): keep current, last 20, and anything < 90 days ──────
create function public.purge_old_snapshots() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('qals.retention', 'on', true);
  with ranked as (
    select s.project_id, s.id, s.published_at,
           row_number() over (partition by s.project_id order by s.version desc) rn
    from snapshots s
  )
  delete from snapshots s using ranked r, projects p
   where s.id = r.id and p.id = s.project_id
     and r.rn > 20 and r.published_at < now() - interval '90 days'
     and s.id is distinct from p.current_snapshot_id;
  get diagnostics n = row_count;
  delete from sync_runs r
   where r.started_at < now() - interval '90 days'
     and not exists (select 1 from snapshots s where s.project_id = r.project_id and s.run_id = r.id);
  perform set_config('qals.retention', 'off', true);
  return n;
end $$;

revoke execute on all functions in schema public from anon, authenticated, public;

-- Realtime: live project-scoped status (FR-SYNC-008, MP-FR-027).
alter publication supabase_realtime add table public.project_state;
