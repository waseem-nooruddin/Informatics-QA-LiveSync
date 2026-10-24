import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET, resolveRuleset } from '../src/ruleset.ts';
import { runPipeline, type PipelineInput } from '../src/pipeline.ts';
import type { RawWorkbook, SourceOutcome } from '../src/types.ts';
import { mainModules, okSource, tcRows, TC_HEADER, workbook } from './fixtures.ts';

const rs = DEFAULT_RULESET;
const EDCS_MM = mainModules('edcs', ['user-management', 'User Management'], ['hrms', 'HRMS']);
const DIE_MM = mainModules('die', ['user-management', 'User Management']);

function run(projectId: string, wbs: RawWorkbook[], extra: Partial<PipelineInput> = {}) {
  return runPipeline({
    projectId,
    rs,
    mappingVersion: 'm1',
    workbooks: wbs,
    sources: wbs.map(okSource),
    mainModules: projectId === 'die' ? DIE_MM : EDCS_MM,
    modules: [],
    mappings: [],
    now: new Date('2026-10-24T00:00:00Z'),
    ...extra,
  });
}

/** The approved Phase 3 sample (User Management: 90 TC, 62 passed, 12 open / 9 closed). */
const umBook = () =>
  workbook('edcs', 'um-book', [
    { name: 'Summary', rows: [['Overall'], ['x']] },
    {
      name: 'User Creation',
      rows: tcRows('UC', [...Array(30).fill('Passed'), ...Array(5).fill('Failed'), 'Blocked', 'Blocked', 'Not Tested', 'Not Tested', 'Not Tested'], [
        ['D-1', 'Open', 'Critical', 'P1'], ['D-2', 'Open', 'High', 'P1'], ['D-3', 'Open', 'High', 'P2'], ['D-4', 'Open', 'Medium', 'P3'],
        ['D-5', 'Closed', 'High', 'P2'], ['D-6', 'Closed', 'Medium', 'P2'], ['D-7', 'Closed', 'Medium', 'P3'], ['D-8', 'Closed', 'Medium', 'P3'], ['D-9', 'Closed', 'Low', 'P3'], ['D-10', 'Closed', 'Low', 'P4'],
      ]),
    },
    {
      name: 'User Roles',
      rows: tcRows('UR', [...Array(20).fill('Passed'), ...Array(4).fill('Failed'), 'Blocked', 'Not Tested', 'Not Tested', 'Not Tested'], [
        ['D-11', 'Open', 'High', 'P1'], ['D-12', 'Open', 'Medium', 'P2'], ['D-13', 'Open', 'Low', 'P2'], ['D-14', 'Closed', 'High', 'P3'], ['D-15', 'Closed', 'Medium', 'P4'],
      ]),
    },
  ]);
const accessBook = () =>
  workbook('edcs', 'access-book', [
    {
      name: 'Permissions',
      rows: tcRows('PM', [...Array(12).fill('Passed'), ...Array(6).fill('Failed'), 'Blocked', 'Blocked', 'Not Tested', 'Not Tested'], [
        ['D-16', 'Open', 'Critical', 'P1'], ['D-17', 'Open', 'Critical', 'P1'], ['D-18', 'Open', 'High', 'P2'], ['D-19', 'Open', 'High', 'P2'], ['D-20', 'Open', 'Medium', 'P3'], ['D-21', 'Closed', 'Low', 'P4'],
      ]),
    },
  ]);
const hrmsBook = () => workbook('edcs', 'hrms-book', [{ name: 'Leave', rows: tcRows('LV', ['Passed', 'Failed']) }, { name: 'Payroll', rows: tcRows('PY', ['Passed']) }], 'hrms');

describe('hierarchy discovery (SRS V1.5 §5)', () => {
  it('builds Project → Main Module → Submodule from attached sources; summary tabs excluded', () => {
    const r = run('edcs', [umBook(), accessBook(), hrmsBook()]);
    expect(r.candidate.hierarchy.map((m) => [m.name, m.submodules.map((s) => s.name)])).toEqual([
      ['HRMS', ['Leave', 'Payroll']],
      ['User Management', ['Permissions', 'User Creation', 'User Roles']],
    ]);
    expect(r.report.runState).toBe('Validated');
  });

  it('reproduces the approved Phase 3 sample numbers exactly', () => {
    const r = run('edcs', [umBook(), accessBook()]);
    const um = r.candidate.table.mainModules.find((m) => m.mainModuleId === 'user-management')!;
    expect({ tc: um.totalTc, p: um.passed, f: um.failed, b: um.blocked, n: um.notTested, o: um.openDefects, c: um.closedDefects }).toEqual({ tc: 90, p: 62, f: 15, b: 5, n: 8, o: 12, c: 9 });
    expect(um.passRatio).toBeCloseTo(68.888, 2);
    expect(um.severity).toEqual({ Critical: 3, High: 7, Medium: 7, Low: 4 });
    expect(um.priority).toEqual({ P1: 5, P2: 7, P3: 6, P4: 3 });
    const pie = r.candidate.charts.byMainModule['user-management']!.moduleByOverall;
    expect(pie).toEqual({ pass: 62, failed: 15, other: 13, total: 90 });
    expect(r.report.publishable).toBe(true);
  });

  it('a source attached to HRMS never lands in User Management', () => {
    const r = run('edcs', [umBook(), hrmsBook()]);
    const hr = r.candidate.table.rows.filter((x) => x.mainModuleId === 'hrms');
    expect(hr.map((x) => x.moduleName).sort()).toEqual(['Leave', 'Payroll']);
    expect(r.candidate.table.mainModules.find((m) => m.mainModuleId === 'hrms')!.totalTc).toBe(3);
  });

  it('AT-10: a new tab named like an existing submodule is quarantined, not auto-merged', () => {
    const first = run('edcs', [umBook()]);
    const second = run('edcs', [umBook(), workbook('edcs', 'other', [{ name: 'User Roles', rows: tcRows('X', ['Passed']) }])], {
      modules: first.discovery.modules, mappings: first.discovery.mappings,
    });
    expect(second.discovery.reviews).toHaveLength(1);
    expect(second.discovery.reviews[0]!.kind).toBe('submodule-name-collision');
    expect(second.candidate.table.overall.totalTc).toBe(68); // quarantined tab not counted
    expect(second.report.publishable).toBe(true);
    expect(second.report.counts.quarantined).toBe(1);
  });

  it('an ignored sheet stays out without blocking', () => {
    const r = run('edcs', [umBook()], { ignoredSheetKeys: ['um-book:3'] });
    expect(r.candidate.table.rows.map((x) => x.moduleName)).toEqual(['User Creation']);
  });

  it('a source attached to an unknown main module is quarantined', () => {
    const r = run('edcs', [workbook('edcs', 'f', [{ name: 'A', rows: tcRows('A', ['Passed']) }], 'ghost')]);
    expect(r.discovery.reviews[0]!.kind).toBe('unknown-main-module');
    expect(r.candidate.table.overall.totalTc).toBe(0);
  });

  it('AT-09: a new tab appears as a new submodule under the correct main module', () => {
    const first = run('edcs', [hrmsBook()]);
    const withNew = workbook('edcs', 'hrms-book', [
      { name: 'Leave', rows: tcRows('LV', ['Passed', 'Failed']) }, { name: 'Payroll', rows: tcRows('PY', ['Passed']) }, { name: 'Attendance', rows: tcRows('AT', ['Passed']) },
    ], 'hrms');
    const r = run('edcs', [withNew], { modules: first.discovery.modules, mappings: first.discovery.mappings });
    expect(r.candidate.hierarchy.find((m) => m.mainModuleId === 'hrms')!.submodules.map((s) => s.name)).toContain('Attendance');
    expect(r.discovery.events.filter((e) => e.type === 'module-created')).toHaveLength(1);
  });

  it('renaming a worksheet keeps the submodule identity', () => {
    const first = run('edcs', [hrmsBook()]);
    const renamed = workbook('edcs', 'hrms-book', [{ name: 'Leave Requests', rows: tcRows('LV', ['Passed', 'Failed']) }, { name: 'Payroll', rows: tcRows('PY', ['Passed']) }], 'hrms');
    const r = run('edcs', [renamed], { modules: first.discovery.modules, mappings: first.discovery.mappings });
    expect(r.candidate.table.rows.map((x) => x.moduleId).sort()).toEqual(['leave', 'payroll']);
    expect(r.discovery.events.some((e) => e.type === 'sheet-renamed')).toBe(true);
  });

  it('a removed sheet blocks publication instead of zeroing the submodule', () => {
    const first = run('edcs', [hrmsBook()]);
    const r = run('edcs', [workbook('edcs', 'hrms-book', [{ name: 'Leave', rows: tcRows('LV', ['Passed']) }], 'hrms')], {
      modules: first.discovery.modules, mappings: first.discovery.mappings,
    });
    expect(r.report.gates.find((g) => g.id === 'VAL-001')!.state).toBe('Failed');
  });

  it('archived main modules are excluded from totals and navigation', () => {
    const mms = EDCS_MM.map((m) => (m.mainModuleId === 'hrms' ? { ...m, active: false } : m));
    const r = run('edcs', [umBook(), hrmsBook()], { mainModules: mms });
    expect(r.candidate.hierarchy.map((m) => m.mainModuleId)).toEqual(['user-management']);
    expect(r.candidate.table.overall.totalTc).toBe(68);
  });
});

describe('project isolation (AT-13)', () => {
  it('same main-module name, submodule names and TC ids in DIE never merge with EDCS', () => {
    const e = run('edcs', [umBook()]);
    const d = run('die', [workbook('die', 'die-book', [{ name: 'User Roles', rows: tcRows('UR', ['Passed', 'Not Run']) }])]);
    expect(d.candidate.table.overall.totalTc).toBe(2);
    expect(e.candidate.table.overall.totalTc).toBe(68);
    expect(d.tests.every((t) => t.projectId === 'die')).toBe(true);
  });
  it('rejects a workbook scoped to another project', () => {
    expect(() => run('die', [umBook()])).toThrow(/belongs to edcs/);
  });
});

describe('validation gates', () => {
  it('calc rule 6: one test case in two submodules of a main module is a conflict', () => {
    const wb = workbook('edcs', 'f', [{ name: 'A', rows: tcRows('TC', ['Passed']) }, { name: 'B', rows: tcRows('TC', ['Passed']) }]);
    const r = run('edcs', [wb]);
    expect(r.report.gates.find((g) => g.id === 'VAL-002')!.state).toBe('Failed');
  });

  it('the same TC id in different main modules is allowed', () => {
    const a = workbook('edcs', 'a', [{ name: 'A', rows: tcRows('TC', ['Passed']) }]);
    const b = workbook('edcs', 'b', [{ name: 'B', rows: tcRows('TC', ['Failed']) }], 'hrms');
    expect(run('edcs', [a, b]).report.publishable).toBe(true);
  });

  it('conflicting statuses without a later execution → VAL-002 fails', () => {
    const wb = workbook('edcs', 'f', [{ name: 'A', rows: [TC_HEADER, ['TC-1', 'a', 'Passed', '2026-10-01'], ['TC-1', 'a', 'Failed', '2026-10-01']] }]);
    expect(run('edcs', [wb]).report.runState).toBe('Validation Failed');
  });

  it('latest execution wins and history is preserved', () => {
    const wb = workbook('edcs', 'f', [{ name: 'A', rows: [TC_HEADER, ['TC-1', 'a', 'Failed', '2026-10-01'], ['TC-1', 'a', 'Passed', '2026-10-05']] }]);
    const r = run('edcs', [wb]);
    expect(r.tests[0]!.status).toBe('Passed');
    expect(r.tests[0]!.executions).toHaveLength(2);
  });

  it('calc rule 8: unknown status blocks publication, never coerced', () => {
    const r = run('edcs', [workbook('edcs', 'f', [{ name: 'A', rows: [TC_HEADER, ['TC-1', 'a', 'Maybe']] }])]);
    expect(r.candidate.table.overall.notTested).toBe(0);
    expect(r.report.publishable).toBe(false);
  });

  it('calc rule 4: an unmapped defect status blocks publication', () => {
    const r = run('edcs', [workbook('edcs', 'f', [{ name: 'A', rows: tcRows('TC', ['Failed'], [['D-1', 'Deferred', 'High', 'P1']]) }])]);
    expect(r.report.gates.find((g) => g.id === 'VAL-005')!.state).toBe('Failed');
  });

  it('defect register resolves submodules only within its own main module', () => {
    const wb = workbook('edcs', 'f', [
      { name: 'Leave', rows: tcRows('LV', ['Passed']) },
      { name: 'Defects', rows: [['Defect ID', 'Module', 'Status', 'Severity', 'Priority'], ['D-1', 'Leave', 'Open', 'Critical', 'P1'], ['D-2', 'User Creation', 'Open', 'Low', 'P4']] },
    ], 'hrms');
    const r = run('edcs', [umBook(), wb]);
    expect(r.issues.map((i) => i.code)).toContain('UNKNOWN_MODULE');
  });

  it('extra independent path disagreeing with the table → VAL-003 fails', () => {
    const r = run('edcs', [hrmsBook()], {
      extraIndependent: [{ label: 'sql', counts: { totalTc: 9, byStatus: {}, open: 0, closed: 0, uniqueDefects: 0, perModuleTc: {} } }],
    });
    expect(r.report.gates.find((g) => g.id === 'VAL-003')!.state).toBe('Failed');
  });

  it('a failed source → Sync Failed', () => {
    const wb = hrmsBook();
    const failed: SourceOutcome = { ...okSource(wb), state: 'failed', errorCode: 'ACCESS_REVOKED' };
    expect(run('edcs', [], { sources: [failed] }).report.runState).toBe('Sync Failed');
  });

  it('calc rule 3: DSI = average weight of open defects (approved formula)', () => {
    const r = run('edcs', [umBook(), accessBook()]);
    const um = r.candidate.table.mainModules.find((m) => m.mainModuleId === 'user-management')!;
    // open weights: UC C10 H5 H5 M3 | UR H5 M3 L1 | PM C10 C10 H5 H5 M3 → 65 / 12
    expect(um.dsi).toEqual({ status: 'ok', value: 65 / 12, formulaVersion: 'dsi-v1' });
    expect(r.report.gates.find((g) => g.id === 'VAL-004-DSI')).toMatchObject({ state: 'Passed', blocking: true });
  });

  it('DSI with an open defect lacking severity fails the (blocking) DSI gate', () => {
    const r = run('edcs', [workbook('edcs', 'f', [{ name: 'A', rows: tcRows('TC', ['Failed'], [['D-1', 'Open', null, 'P1']]) }])]);
    expect(r.report.gates.find((g) => g.id === 'VAL-004-DSI')!.state).toBe('Failed');
    expect(r.report.publishable).toBe(false);
  });

  it('with no DSI formula the DSI gate is Pending and non-blocking', () => {
    const r = run('edcs', [hrmsBook()], { rs: resolveRuleset({ dsi: null }) });
    expect(r.report.gates.find((g) => g.id === 'VAL-004-DSI')).toMatchObject({ state: 'Pending', blocking: false });
    expect(r.report.publishable).toBe(true);
  });

  it('zero test cases → pass ratio N/A', () => {
    const r = run('edcs', [workbook('edcs', 'f', [{ name: 'A', rows: [TC_HEADER] }])]);
    expect(r.candidate.kpis.passRatio).toBeNull();
    expect(r.report.publishable).toBe(true);
  });

  it('every scope satisfies Total = P + F + B + NT and Pass + Failed + Other = Total', () => {
    const r = run('edcs', [umBook(), accessBook(), hrmsBook()]);
    for (const row of [...r.candidate.table.rows, ...r.candidate.table.mainModules, r.candidate.table.overall]) {
      expect(row.passed + row.failed + row.blocked + row.notTested).toBe(row.totalTc);
    }
    for (const c of [r.candidate.charts.project, ...Object.values(r.candidate.charts.byMainModule)]) {
      expect(c.moduleByOverall.pass + c.moduleByOverall.failed + c.moduleByOverall.other).toBe(c.moduleByOverall.total);
    }
  });
});
