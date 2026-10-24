import { describe, expect, it } from 'vitest';
import { DEFAULT_RULESET } from '../src/ruleset.ts';
import { runPipeline } from '../src/pipeline.ts';
import { selectScope, statusPercentages } from '../src/scope.ts';
import { diffCharts } from '../src/validate.ts';
import { mainModules, okSource, tcRows, workbook } from './fixtures.ts';

const rs = DEFAULT_RULESET;
function snapshot() {
  const wbs = [
    workbook('edcs', 'um', [
      { name: 'User Creation', rows: tcRows('UC', ['Passed', 'Passed', 'Failed', 'Blocked'], [[], [], ['D-1', 'Open', 'High', 'P1'], ['D-2', 'Closed', 'Low', 'P4']]) },
      { name: 'User Roles', rows: tcRows('UR', ['Passed', 'Not Tested', 'Not Tested'], [['D-3', 'Open', 'Critical', 'P1']]) },
      { name: 'Permissions', rows: tcRows('PM', ['Failed', 'Failed']) },
    ]),
    workbook('edcs', 'hr', [{ name: 'Leave', rows: tcRows('LV', ['Passed']) }], 'hrms'),
  ];
  return runPipeline({
    projectId: 'edcs', rs, mappingVersion: 'm1', workbooks: wbs, sources: wbs.map(okSource),
    mainModules: mainModules('edcs', ['user-management', 'User Management'], ['hrms', 'HRMS']), modules: [], mappings: [],
  });
}

describe('selectScope — one function for dashboards, filters and exports (V1.5 §5.4–5.5)', () => {
  const r = snapshot();
  const t = r.candidate.table;

  it('Overall Dashboard = all submodules of the main module and nothing else', () => {
    const v = selectScope(t, rs, { mainModuleId: 'user-management' });
    expect(v.kpis.totalTc).toBe(9);
    expect(v.groups.map((g) => g.name)).toEqual(['Permissions', 'User Creation', 'User Roles']);
    expect(diffCharts('um', v.charts, r.candidate.charts.byMainModule['user-management']!)).toEqual([]);
  });

  it('Detailed Dashboard: one or several submodules sum exactly (no double counting)', () => {
    const one = selectScope(t, rs, { mainModuleId: 'user-management', submoduleIds: ['user-roles'] });
    expect(one.kpis).toMatchObject({ totalTc: 3, passed: 1, openDefects: 1 });
    expect(one.filtered).toBe(true);
    const two = selectScope(t, rs, { mainModuleId: 'user-management', submoduleIds: ['user-roles', 'user-creation'] });
    expect(two.kpis.totalTc).toBe(7);
    expect(two.charts.moduleByOverall).toEqual({ pass: 3, failed: 1, other: 3, total: 7 });
    expect(two.charts.openVsClosed).toEqual({ Open: 2, Closed: 1 });
  });

  it('a submodule id from another main module is ignored', () => {
    const v = selectScope(t, rs, { mainModuleId: 'user-management', submoduleIds: ['leave'] });
    expect(v.kpis.totalTc).toBe(9);
    expect(v.filtered).toBe(false);
  });

  it('project scope groups by main module and equals the overall total', () => {
    const v = selectScope(t, rs);
    expect(v.groups.map((g) => g.name)).toEqual(['HRMS', 'User Management']);
    expect(v.kpis.totalTc).toBe(t.overall.totalTc);
    expect(diffCharts('project', v.charts, r.candidate.charts.project)).toEqual([]);
  });

  it('DSI recombines exactly for a filtered selection', () => {
    const v = selectScope(t, rs, { mainModuleId: 'user-management', submoduleIds: ['user-creation', 'user-roles'] });
    // open: High 5 + Critical 10 → 15 / 2
    expect(v.totals.dsi).toEqual({ status: 'ok', value: 7.5, formulaVersion: 'dsi-v1' });
  });

  it('AT-15: test status shares sum to 100% before rounding; zero TC → null', () => {
    for (const row of t.rows) {
      const p = statusPercentages(row)!;
      expect(Object.values(p).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    }
    expect(statusPercentages({ passed: 0, failed: 0, blocked: 0, notTested: 0, totalTc: 0 })).toBeNull();
  });
});
