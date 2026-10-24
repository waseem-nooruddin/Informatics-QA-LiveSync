import { chartsFromGroups, combineCounts, kpisOf, totalRow, type ScopeRules } from './aggregate.ts';
import type { ChartData, Counts, Group, Kpis, MainModuleId, ModuleId, ModuleRow, TableData, TotalRow } from './types.ts';

/** Any table row shape with the counts and identity a scope needs (server rows or public rows). */
export type ScopeRow = Omit<ModuleRow, 'sources'> & { sources: { sheetTitle: string }[] };
export interface ScopeTable<R extends ScopeRow = ModuleRow> {
  rows: R[];
  mainModules: TableData['mainModules'];
}

export interface ScopeSelection {
  /** Omit for project scope (charts grouped by main module). */
  mainModuleId?: MainModuleId;
  /** Empty or omitted = All Submodules of the main module. */
  submoduleIds?: ModuleId[];
}

export interface ScopeView<R extends ScopeRow = ModuleRow> {
  level: 'project' | 'main-module';
  /** Table rows in scope (submodule rows). */
  rows: R[];
  /** Chart categories: submodules (main-module scope) or main modules (project scope). */
  groups: (Group & Counts)[];
  totals: TotalRow;
  kpis: Kpis;
  charts: ChartData;
  /** True when a submodule filter narrows the main module. */
  filtered: boolean;
}

/**
 * The one function every dashboard, filter and export uses (SRS V1.5 §5.4–§5.5): all KPIs,
 * the eight charts and the table for a scope come from the same snapshot rows, so they
 * reconcile by construction. Submodule filters only ever select within one main module.
 */
export function selectScope<R extends ScopeRow>(table: ScopeTable<R>, rules: ScopeRules, sel: ScopeSelection = {}): ScopeView<R> {
  if (!sel.mainModuleId) {
    const groups = table.mainModules.map((m) => {
      const rows = table.rows.filter((r) => r.mainModuleId === m.mainModuleId);
      return { id: m.mainModuleId, name: m.name, ...combineCounts(rows, rules) };
    });
    const total = combineCounts(table.rows, rules);
    const totals = totalRow(total, table.rows.length, rules);
    return { level: 'project', rows: table.rows, groups, totals, kpis: kpisOf(totals), charts: chartsFromGroups(groups, total, rules), filtered: false };
  }
  const inMain = table.rows.filter((r) => r.mainModuleId === sel.mainModuleId);
  const wanted = new Set((sel.submoduleIds ?? []).filter((id) => inMain.some((r) => r.moduleId === id)));
  const rows = wanted.size ? inMain.filter((r) => wanted.has(r.moduleId)) : inMain;
  const groups = rows.map((r) => ({ id: r.moduleId, name: r.moduleName, ...pickCounts(r) }));
  const total = combineCounts(rows, rules);
  const totals = totalRow(total, rows.length, rules);
  return { level: 'main-module', rows, groups, totals, kpis: kpisOf(totals), charts: chartsFromGroups(groups, total, rules), filtered: wanted.size > 0 && wanted.size < inMain.length };
}

function pickCounts(r: Counts): Counts {
  const { totalTc, passed, failed, blocked, notTested, openDefects, closedDefects, severity, priority, dsiParts } = r;
  return { totalTc, passed, failed, blocked, notTested, openDefects, closedDefects, severity, priority, dsiParts };
}

/** Test status shares for one row; sums to exactly 100 before rounding (AT-15). Null when no TC. */
export function statusPercentages(c: Pick<Counts, 'passed' | 'failed' | 'blocked' | 'notTested' | 'totalTc'>): Record<'Passed' | 'Failed' | 'Blocked' | 'Not Tested', number> | null {
  if (c.totalTc === 0) return null;
  const f = (v: number) => (v / c.totalTc) * 100;
  return { Passed: f(c.passed), Failed: f(c.failed), Blocked: f(c.blocked), 'Not Tested': f(c.notTested) };
}
