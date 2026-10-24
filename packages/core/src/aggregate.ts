import { addDsiParts, dsiParts, dsiValue } from './dsi.ts';
import type {
  ChartData,
  CountMap,
  Counts,
  DefectRecord,
  Group,
  HierarchyNode,
  Kpis,
  MainModuleEntry,
  MainModuleId,
  ModuleEntry,
  ModuleId,
  ModuleMapping,
  ModuleRow,
  Ruleset,
  TableData,
  TestRecord,
  TotalRow,
} from './types.ts';

export const UNSPECIFIED = 'Unspecified';

/** Exact chart titles (SRS V1.5 §9) shared by UI, exports and validation evidence. */
export const CHART_TITLES = {
  moduleRegistration: 'Module Registration by Total Number of TC',
  moduleByOverall: 'Module by OverAll',
  testStatusByModule: 'Test Status by Module',
  openVsClosed: 'Total Open Defects vs. Closed Defects',
  openVsClosedByModule: 'Total Open Defects vs. Closed Defects by Module',
  severityByModule: 'Defect Severity By Module',
  priorityByModule: 'Defect Priority by Module',
  dsiByModule: 'DSI by Module',
} as const;

export const KPI_LABELS = {
  totalTc: 'Total Number of TC',
  passed: 'Test Cases Passed',
  openDefects: 'Total Open Defects',
  passRatio: 'Test Pass Ratio',
} as const;

export type ScopeRules = Pick<Ruleset, 'severityCategories' | 'priorityCategories' | 'otherStatuses' | 'dsi' | 'defectPopulation'>;

/** Unrounded pass ratio; N/A (null) on zero denominator (calc-v1 rule 1). */
export function passRatio(passed: number, totalTc: number): number | null {
  return totalTc === 0 ? null : (passed / totalTc) * 100;
}

function emptyCats(categories: string[]): CountMap {
  return Object.fromEntries(categories.map((c) => [c, 0]));
}

function population(defects: DefectRecord[], which: 'all' | 'open'): DefectRecord[] {
  return which === 'open' ? defects.filter((d) => d.lifecycle === 'Open') : defects;
}

/** Counts for one set of canonical records (the table path). */
export function countsOf(tests: TestRecord[], defects: DefectRecord[], rs: ScopeRules): Counts {
  const by = (s: TestRecord['status']) => tests.filter((t) => t.status === s).length;
  const sev = emptyCats(rs.severityCategories);
  for (const d of population(defects, rs.defectPopulation.severity)) {
    const k = d.severity ?? UNSPECIFIED;
    sev[k] = (sev[k] ?? 0) + 1;
  }
  const pri = emptyCats(rs.priorityCategories);
  for (const d of population(defects, rs.defectPopulation.priority)) {
    const k = d.priority ?? UNSPECIFIED;
    pri[k] = (pri[k] ?? 0) + 1;
  }
  return {
    totalTc: tests.length,
    passed: by('Passed'),
    failed: by('Failed'),
    blocked: by('Blocked'),
    notTested: by('Not Tested'),
    openDefects: defects.filter((d) => d.lifecycle === 'Open').length,
    closedDefects: defects.filter((d) => d.lifecycle === 'Closed').length,
    severity: sev,
    priority: pri,
    dsiParts: dsiParts(rs.dsi, defects),
  };
}

/** Exact sum of counts (valid because every case/defect belongs to one submodule — calc-v1 rule 6). */
export function combineCounts(list: Counts[], rs: ScopeRules): Counts {
  const out: Counts = {
    totalTc: 0, passed: 0, failed: 0, blocked: 0, notTested: 0, openDefects: 0, closedDefects: 0,
    severity: emptyCats(rs.severityCategories), priority: emptyCats(rs.priorityCategories), dsiParts: { weighted: 0, count: 0 },
  };
  for (const c of list) {
    out.totalTc += c.totalTc;
    out.passed += c.passed;
    out.failed += c.failed;
    out.blocked += c.blocked;
    out.notTested += c.notTested;
    out.openDefects += c.openDefects;
    out.closedDefects += c.closedDefects;
    for (const [k, v] of Object.entries(c.severity)) out.severity[k] = (out.severity[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.priority)) out.priority[k] = (out.priority[k] ?? 0) + v;
    out.dsiParts = addDsiParts(out.dsiParts, c.dsiParts);
  }
  return out;
}

export function totalRow(c: Counts, moduleCount: number, rs: ScopeRules): TotalRow {
  return { ...c, moduleCount, passRatio: passRatio(c.passed, c.totalTc), dsi: dsiValue(rs.dsi, c.dsiParts, c.totalTc) };
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** Active main modules and their active submodules, sorted deterministically (SRS V1.5 §5.2). */
export function buildHierarchy(mainModules: MainModuleEntry[], modules: ModuleEntry[]): HierarchyNode[] {
  return mainModules
    .filter((m) => m.active)
    .map((m) => ({ mainModuleId: m.mainModuleId, name: m.name }))
    .sort(byName)
    .map((m) => ({
      ...m,
      submodules: modules
        .filter((s) => s.active && s.mainModuleId === m.mainModuleId)
        .map((s) => ({ id: s.moduleId, name: s.name }))
        .sort(byName),
    }));
}

export interface TableInput {
  tests: TestRecord[];
  defects: DefectRecord[];
  hierarchy: HierarchyNode[];
  mappings: ModuleMapping[];
  rs: Ruleset;
  lastSourceUpdate: Record<string, string | null>; // fileId -> modifiedAt
}

/** Primary aggregation: the authoritative Overall Detailed Table (SRS V1.5 §7). */
export function buildTable(input: TableInput): TableData {
  const { rs } = input;
  const rows: ModuleRow[] = [];
  const mainModules: TableData['mainModules'] = [];
  for (const mm of input.hierarchy) {
    const mmRows: ModuleRow[] = mm.submodules.map((s) => {
      const c = countsOf(
        input.tests.filter((t) => t.mainModuleId === mm.mainModuleId && t.moduleId === s.id),
        input.defects.filter((d) => d.mainModuleId === mm.mainModuleId && d.moduleId === s.id),
        rs,
      );
      const maps = input.mappings.filter((x) => x.moduleId === s.id);
      const updates = maps.map((x) => input.lastSourceUpdate[x.fileId]).filter((x): x is string => !!x).sort();
      return {
        ...c,
        mainModuleId: mm.mainModuleId,
        mainModuleName: mm.name,
        moduleId: s.id,
        moduleName: s.name,
        passRatio: passRatio(c.passed, c.totalTc),
        dsi: dsiValue(rs.dsi, c.dsiParts, c.totalTc),
        sources: maps.map(({ sourceId, fileId, sheetId, sheetTitle }) => ({ sourceId, fileId, sheetId, sheetTitle })),
        lastSourceUpdate: updates.at(-1) ?? null,
      };
    });
    rows.push(...mmRows);
    mainModules.push({ mainModuleId: mm.mainModuleId, name: mm.name, ...totalRow(combineCounts(mmRows, rs), mmRows.length, rs) });
  }
  return { rows, mainModules, overall: totalRow(combineCounts(rows, rs), rows.length, rs) };
}

export function kpisOf(t: Pick<TotalRow, 'totalTc' | 'passed' | 'openDefects' | 'passRatio'>): Kpis {
  return { totalTc: t.totalTc, passed: t.passed, openDefects: t.openDefects, passRatio: t.passRatio };
}

/** Build all eight chart datasets from per-group counts (used by both paths' final shaping). */
export function chartsFromGroups(groups: (Group & Counts)[], total: Counts, rs: ScopeRules): ChartData {
  const other = rs.otherStatuses.reduce((a, s) => a + statusCount(total, s), 0);
  return {
    moduleRegistration: groups.map((g) => ({ id: g.id, name: g.name, totalTc: g.totalTc })),
    moduleByOverall: { pass: total.passed, failed: total.failed, other, total: total.totalTc },
    testStatusByModule: groups.map((g) => ({ id: g.id, name: g.name, Passed: g.passed, Failed: g.failed, Blocked: g.blocked, 'Not Tested': g.notTested })),
    openVsClosed: { Open: total.openDefects, Closed: total.closedDefects },
    openVsClosedByModule: groups.map((g) => ({ id: g.id, name: g.name, Open: g.openDefects, Closed: g.closedDefects })),
    severityByModule: groups.map((g) => ({ id: g.id, name: g.name, counts: { ...g.severity } })),
    priorityByModule: groups.map((g) => ({ id: g.id, name: g.name, counts: { ...g.priority } })),
    dsiByModule: groups.map((g) => ({ id: g.id, name: g.name, dsi: dsiValue(rs.dsi, g.dsiParts, g.totalTc) })),
  };
}

function statusCount(c: Counts, s: string): number {
  return s === 'Passed' ? c.passed : s === 'Failed' ? c.failed : s === 'Blocked' ? c.blocked : s === 'Not Tested' ? c.notTested : 0;
}

/**
 * Chart datasets computed directly from canonical records — a deliberately separate path
 * from buildTable, so VAL-004 genuinely reconciles all eight charts to the table.
 */
export function buildChartSet(
  tests: TestRecord[],
  defects: DefectRecord[],
  hierarchy: HierarchyNode[],
  rs: Ruleset,
): { project: ChartData; byMainModule: Record<MainModuleId, ChartData> } {
  const subKey = (mm: string, s: string) => `${mm}\u0000${s}`;
  const tBy = new Map<string, TestRecord[]>();
  const dBy = new Map<string, DefectRecord[]>();
  for (const t of tests) tBy.set(subKey(t.mainModuleId, t.moduleId), [...(tBy.get(subKey(t.mainModuleId, t.moduleId)) ?? []), t]);
  for (const d of defects) dBy.set(subKey(d.mainModuleId, d.moduleId), [...(dBy.get(subKey(d.mainModuleId, d.moduleId)) ?? []), d]);

  const byMainModule: Record<MainModuleId, ChartData> = {};
  const projectGroups: (Group & Counts)[] = [];
  const projectTests: TestRecord[] = [];
  const projectDefects: DefectRecord[] = [];
  for (const mm of hierarchy) {
    const groups = mm.submodules.map((s) => {
      const t = tBy.get(subKey(mm.mainModuleId, s.id)) ?? [];
      const d = dBy.get(subKey(mm.mainModuleId, s.id)) ?? [];
      return { id: s.id, name: s.name, ...countsOf(t, d, rs) };
    });
    const mmTests = mm.submodules.flatMap((s) => tBy.get(subKey(mm.mainModuleId, s.id)) ?? []);
    const mmDefects = mm.submodules.flatMap((s) => dBy.get(subKey(mm.mainModuleId, s.id)) ?? []);
    const mmTotal = countsOf(mmTests, mmDefects, rs);
    byMainModule[mm.mainModuleId] = chartsFromGroups(groups, mmTotal, rs);
    projectGroups.push({ id: mm.mainModuleId, name: mm.name, ...mmTotal });
    projectTests.push(...mmTests);
    projectDefects.push(...mmDefects);
  }
  return { project: chartsFromGroups(projectGroups, countsOf(projectTests, projectDefects, rs), rs), byMainModule };
}

export interface IndependentCounts {
  totalTc: number;
  byStatus: Record<string, number>;
  open: number;
  closed: number;
  uniqueDefects: number;
  perModuleTc: Record<ModuleId, number>;
}

/** Independent reconciliation path for critical totals (FR-VAL-006 / V1.5 §10). */
export function independentCounts(tests: TestRecord[], defects: DefectRecord[], activeModuleIds: ModuleId[]): IndependentCounts {
  const active = new Set(activeModuleIds);
  const tKeys = new Set<string>();
  const byStatus: Record<string, number> = {};
  const perModuleTc: Record<ModuleId, number> = {};
  for (const t of tests) {
    if (!active.has(t.moduleId)) continue;
    const k = `${t.projectId}\u0000${t.mainModuleId}\u0000${t.moduleId}\u0000${t.testCaseId}`;
    if (tKeys.has(k)) continue;
    tKeys.add(k);
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    perModuleTc[t.moduleId] = (perModuleTc[t.moduleId] ?? 0) + 1;
  }
  const dKeys = new Map<string, string>();
  for (const d of defects) if (active.has(d.moduleId)) dKeys.set(`${d.projectId}\u0000${d.defectId}`, d.lifecycle);
  const lifecycles = [...dKeys.values()];
  return {
    totalTc: tKeys.size,
    byStatus,
    open: lifecycles.filter((l) => l === 'Open').length,
    closed: lifecycles.filter((l) => l === 'Closed').length,
    uniqueDefects: dKeys.size,
    perModuleTc,
  };
}
