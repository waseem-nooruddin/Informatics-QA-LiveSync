-- pgTAP: access control, hard project isolation and publication semantics.
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- Fixture: two projects (seeded edcs/die may exist; use dedicated ids).
select public.create_project('t-edcs', 'T EDCS', 'test');
select public.create_project('t-die', 'T DIE', 'test');
insert into public.main_modules (project_id, id, name) values ('t-edcs', 'um', 'User Management'), ('t-edcs', 'hrms', 'HRMS'), ('t-die', 'um', 'User Management');
insert into public.modules (project_id, main_module_id, id, name) values ('t-edcs', 'um', 'login', 'Login'), ('t-die', 'um', 'login', 'Login'), ('t-edcs', 'hrms', 'leave', 'Leave');
insert into public.sync_runs (id, project_id, trigger) values
  ('00000000-0000-0000-0000-0000000000a1', 't-edcs', 'manual'),
  ('00000000-0000-0000-0000-0000000000a2', 't-edcs', 'manual'),
  ('00000000-0000-0000-0000-0000000000b1', 't-die', 'manual');

-- ── MP-FR-021: identical module ids / TC ids in two projects never collide ──
select lives_ok(
  $$ insert into public.canonical_tests (project_id, run_id, main_module_id, module_id, test_case_id, status, lineage) values
     ('t-edcs', '00000000-0000-0000-0000-0000000000a1', 'um', 'login', 'TC-1', 'Passed', '{}'),
     ('t-die',  '00000000-0000-0000-0000-0000000000b1', 'um', 'login', 'TC-1', 'Failed', '{}') $$,
  'same module + test case id coexist in two projects');

-- ── MP-FR-019/020: composite FKs block cross-project references ──
select throws_ok(
  $$ insert into public.canonical_tests (project_id, run_id, main_module_id, module_id, test_case_id, status, lineage)
     values ('t-die', '00000000-0000-0000-0000-0000000000a1', 'um', 'login', 'TC-9', 'Passed', '{}') $$,
  '23503', null, 'a DIE record cannot reference an EDCS run');
select throws_ok(
  $$ insert into public.module_mappings (project_id, file_id, sheet_id, main_module_id, module_id, source_id, sheet_title)
     values ('t-die', 'f', '1', 'um', 'nonexistent', 's', 'x') $$,
  '23503', null, 'mappings must reference a submodule of the same project');

-- ── V1.5: a submodule record cannot be filed under another main module ──
select throws_ok(
  $$ insert into public.canonical_tests (project_id, run_id, main_module_id, module_id, test_case_id, status, lineage)
     values ('t-edcs', '00000000-0000-0000-0000-0000000000a1', 'hrms', 'login', 'TC-2', 'Passed', '{}') $$,
  '23503', null, 'Login (User Management) cannot be counted under HRMS');
select throws_ok(
  $$ insert into public.modules (project_id, main_module_id, id, name) values ('t-edcs', 'ghost', 'x', 'X') $$,
  '23503', null, 'a submodule needs an existing main module of the same project');
select throws_ok(
  $$ insert into public.modules (project_id, main_module_id, id, name) values ('t-die', 'hrms', 'y', 'Y') $$,
  '23503', null, 'a DIE submodule cannot hang under an EDCS main module');

-- ── One Drive folder roots one project ──
insert into public.project_roots (project_id, folder_id, folder_name) values ('t-edcs', 'folder-1', 'EDCS QA');
select throws_ok(
  $$ insert into public.project_roots (project_id, folder_id, folder_name) values ('t-die', 'folder-1', 'EDCS QA') $$,
  '23505', null, 'the same Drive folder cannot root two projects');

-- ── Independent SQL reconciliation is project-scoped ──
select is((public.reconcile_counts('t-edcs', '00000000-0000-0000-0000-0000000000a1')->>'totalTc')::int, 1, 'reconcile counts only EDCS rows');
select is(public.reconcile_counts('t-edcs', '00000000-0000-0000-0000-0000000000a1')->'byStatus'->>'Passed', '1', 'reconcile status counts');

-- ── FR-PUB: only validated runs publish; newer version wins; older is rejected ──
select throws_ok(
  $$ select public.publish_snapshot('t-edcs', '00000000-0000-0000-0000-0000000000a2', now(), 'v0', true, 'm1', '{}', '{}', '{}', '[]', '{}') $$,
  'P0001', null, 'publish refuses a run without a passing validation result');

insert into public.validation_results (project_id, run_id, gates, publishable, run_state, counts, ruleset_version, mapping_version) values
  ('t-edcs', '00000000-0000-0000-0000-0000000000a1', '[]', true, 'Validated', '{}', 'v0', 'm1'),
  ('t-edcs', '00000000-0000-0000-0000-0000000000a2', '[]', true, 'Validated', '{}', 'v0', 'm1');

select lives_ok(
  $$ select public.publish_snapshot('t-edcs', '00000000-0000-0000-0000-0000000000a2', now(), 'v0', true, 'm1', '{"table":{"modules":[]}}', '{"table":{"modules":[]}}', '{}', '[]', '{}') $$,
  'newer run publishes');
select throws_like(
  $$ select public.publish_snapshot('t-edcs', '00000000-0000-0000-0000-0000000000a1', now(), 'v0', true, 'm1', '{}', '{}', '{}', '[]', '{}') $$,
  '%STALE_RUN%', 'AT-015: an older run cannot overwrite a newer published snapshot');
select is((select count(*)::int from public.snapshots where project_id = 't-edcs'), 1, 'exactly one EDCS snapshot');
select is((select run_state from public.project_state where project_id = 't-edcs'), 'Validated', 'EDCS state validated');
select is((select current_snapshot_id from public.projects where id = 't-die'), null, 'MP-FR-026: DIE unaffected by EDCS publication');
select isnt((select snapshot_id from public.project_state where project_id = 't-edcs'), null, 'project_state carries the published snapshot id');

-- ── FR-AUD-002: snapshots are immutable ──
select throws_like($$ update public.snapshots set version = 99 where project_id = 't-edcs' $$, '%immutable%', 'snapshots cannot be updated');
select throws_like($$ delete from public.snapshots where project_id = 't-edcs' $$, '%immutable%', 'snapshots cannot be deleted outside retention');

-- ── Project id is immutable; duplicates rejected (MP-FR-002) ──
select throws_like($$ update public.projects set id = 'renamed' where id = 't-die' $$, '%immutable%', 'project id cannot change');
select throws_like($$ select public.create_project('t-die', 'Again', 'test') $$, '%PROJECT_EXISTS%', 'duplicate project id rejected');

-- ── MP-FR-018: one source → one project unless an approved exception exists ──
insert into public.source_connections (project_id, provider, external_id, display_name) values ('t-edcs', 'google-sheets', 'sheet-123', 'Book');
select throws_like(
  $$ insert into public.source_connections (project_id, provider, external_id, display_name) values ('t-die', 'google-sheets', 'sheet-123', 'Book') $$,
  '%SOURCE_IN_OTHER_PROJECT%', 'same source cannot be connected to a second project implicitly');
insert into public.source_project_exceptions (provider, external_id, project_id, reason, approved_by) values ('google-sheets', 'sheet-123', 't-die', 'shared regression book', 'qa-owner');
select lives_ok(
  $$ insert into public.source_connections (project_id, provider, external_id, display_name) values ('t-die', 'google-sheets', 'sheet-123', 'Book') $$,
  'explicit, auditable exception allows it');

-- ── SEC-002/003: anon sees curated aggregates only ──
set local role anon;
select throws_ok($$ select * from public.canonical_tests $$, '42501', null, 'anon cannot read raw test records');
select throws_ok($$ select * from public.mapping_reviews $$, '42501', null, 'anon cannot read the review queue');
select throws_ok($$ select public.publish_snapshot('t-edcs', '00000000-0000-0000-0000-0000000000a1', now(), 'v0', true, 'm1', '{}', '{}', '{}', '[]', '{}') $$, '42501', null, 'anon cannot publish');
reset role;

select * from finish();
rollback;
