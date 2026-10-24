-- LOCAL DEVELOPMENT ONLY (applied by `supabase db reset`). Never run in production.
-- Admin key for local dev: local-dev-admin-key-0000
insert into public.admin_keys (label, key_hash, scope)
values ('local-dev', '8354bde296ef13615b503ab6e6e7eade478f50519ce06623bd071a0b2788e2b5', 'platform');

select public.create_project('edcs', 'EDCS', 'seed');
select public.create_project('die', 'DIE', 'seed');

-- Scheduler secrets for the local stack (functions served by `supabase functions serve`).
select vault.create_secret('http://kong:8000/functions/v1', 'qals_functions_url');
select vault.create_secret('local-worker-secret-change-me', 'qals_worker_secret');

-- Example main modules for local development (in production they come from the Drive folder picker).
insert into public.main_modules (project_id, id, name) values
  ('edcs', 'user-management', 'User Management'),
  ('edcs', 'hrms', 'HRMS'),
  ('die', 'user-management', 'User Management');
