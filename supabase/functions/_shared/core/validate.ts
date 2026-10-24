import { CHART_TITLES, type IndependentCounts, type ScopeRules } from './aggregate.ts';
import type { DiscoveryEvent } from './discovery.ts';
import { selectScope } from './scope.ts';
import type {
  CandidateSnapshot,
  ChartData,
  Conflict,
  CountMap,
  Counts,
  DefectRecord,
  GateResult,
  MappingReview,
  ModuleEntry,
  ProjectId,
  RecordIssue,
  RunState,
  SourceOutcome,
  TestRecord,
  ValidationReport,
} from './types.ts';

export interface ValidationInput {
  projectId: ProjectId;
  candidate: CandidateSnapshot;
  rules: ScopeRules;
  sources: SourceOutcome[];
  discoveryEvents: DiscoveryEvent[];
  conflicts: Conflict[];
  reviews: MappingReview[];
  duplicates: number;
  decisions: number;
  issues: RecordIssue[];
  tests: TestRecord[];
  defects: DefectRecord[];
  modules: ModuleEntry[];
  /** One or more independently computed count sets (TS path, SQL path). */
  independent: { label: string; counts: IndependentCounts }[];
  /** totalTc per submodule in the last published snapshot, to detect emptied sources. */
  previousModuleTc?: Record<string, number>;
}

const gate = (id: GateResult['id'], name: string, discrepancies: string[], evidence: Record<string, unknown>, blocking = true): GateResult => ({
  id, name, state: discrepancies.length === 0 ? 'Passed' : 'Failed', blocking, evidence, discrepancies,
});

const statusSum = (c: Counts) => c.passed + c.failed + c.blocked + c.notTested;

/** Five-point automated validation gate (SRS V1.5 §10). No manual overrides exist. */
export function validate(input: ValidationInput): ValidationReport {
  const { candidate: c, rules } = input;
  const t = c.table;
  const gates: GateResult[] = [];

  // VAL-001 — all applicable source records were read successfully
  {
    const d: string[] = [];
    for (const s of input.sources) if (s.state === 'failed') d.push(`Source “${s.fileName}” could not be read (${s.errorCode ?? 'ERROR'})`);
    for (const e of input.discoveryEvents) {
      if (e.type === 'sheet-missing') d.push(`Worksheet “${e.sheetTitle}” for submodule ${e.moduleId} is missing from its source; archive the submodule or restore the sheet`);
    }
    if (input.previousModuleTc) {
      for (const r of t.rows) {
        const prev = input.previousModuleTc[r.moduleId] ?? 0;
        if (prev > 0 && r.totalTc === 0) d.push(`Submodule ${r.moduleName} dropped from ${prev} test cases to 0 — treated as an empty source`);
      }
    }
    gates.push(gate('VAL-001', 'All source records read', d, {
      sources: input.sources.map((s) => ({ fileName: s.fileName, state: s.state, revision: s.revision })),
      quarantinedForReview: input.reviews.length,
    }));
  }

  // VAL-002 — duplicates and conflicts handled under approved rules
  gates.push(gate('VAL-002', 'Duplicates and conflicts handled', input.conflicts.map((x) => x.detail), {
    duplicatesResolved: input.duplicates, decisions: input.decisions, unresolvedConflicts: input.conflicts.length,
  }));

  // VAL-003 — test case and defect counts reconcile (submodule → main module → project)
  {
    const d: string[] = [];
    for (const r of t.rows) if (statusSum(r) !== r.totalTc) d.push(`${r.mainModuleName} › ${r.moduleName}: status sum ${statusSum(r)} ≠ Total TC ${r.totalTc}`);
    const sumOf = (rows: Counts[], k: keyof Omit<Counts, 'severity' | 'priority' | 'dsiParts'>) => rows.reduce((a, r) => a + (r[k] as number), 0);
    const KEYS = ['totalTc', 'passed', 'failed', 'blocked', 'notTested', 'openDefects', 'closedDefects'] as const;
    for (const mm of t.mainModules) {
      const rows = t.rows.filter((r) => r.mainModuleId === mm.mainModuleId);
      for (const k of KEYS) if (sumOf(rows, k) !== mm[k]) d.push(`${mm.name}: Σ submodule ${k} ${sumOf(rows, k)} ≠ main-module ${mm[k]}`);
      if (statusSum(mm) !== mm.totalTc) d.push(`${mm.name}: status sum ≠ Total TC`);
    }
    for (const k of KEYS) {
      if (sumOf(t.rows, k) !== t.overall[k]) d.push(`Project: Σ submodule ${k} ≠ overall`);
      if (sumOf(t.mainModules, k) !== t.overall[k]) d.push(`Project: Σ main-module ${k} ≠ overall`);
    }
    const o = t.overall;
    for (const { label, counts } of input.independent) {
      if (counts.totalTc !== o.totalTc) d.push(`[${label}] Total TC ${counts.totalTc} ≠ table ${o.totalTc}`);
      const pairs: [string, number][] = [['Passed', o.passed], ['Failed', o.failed], ['Blocked', o.blocked], ['Not Tested', o.notTested]];
      for (const [s, v] of pairs) if ((counts.byStatus[s] ?? 0) !== v) d.push(`[${label}] ${s} ${counts.byStatus[s] ?? 0} ≠ table ${v}`);
      if (counts.open !== o.openDefects) d.push(`[${label}] Open defects ${counts.open} ≠ table ${o.openDefects}`);
      if (counts.closed !== o.closedDefects) d.push(`[${label}] Closed defects ${counts.closed} ≠ table ${o.closedDefects}`);
      if (counts.uniqueDefects !== o.openDefects + o.closedDefects) d.push(`[${label}] unique defects ≠ open + closed`);
      for (const r of t.rows) {
        if ((counts.perModuleTc[r.moduleId] ?? 0) !== r.totalTc) d.push(`[${label}] ${r.moduleName} TC ${counts.perModuleTc[r.moduleId] ?? 0} ≠ table ${r.totalTc}`);
      }
    }
    gates.push(gate('VAL-003', 'Test case and defect counts reconcile', d, { independentPaths: input.independent.map((x) => x.label), mainModules: t.mainModules.length, submodules: t.rows.length }));
  }

  // VAL-004 — every chart matches the Overall Detailed Table and KPI aggregates, in every scope
  const dsiIssues: string[] = [];
  {
    const d: string[] = [];
    const scopes: { label: string; independent: ChartData; fromTable: ChartData; kpiTotal: number }[] = [];
    const proj = selectScope(t, rules);
    scopes.push({ label: 'Project', independent: c.charts.project, fromTable: proj.charts, kpiTotal: proj.kpis.totalTc });
    if (c.kpis.totalTc !== t.overall.totalTc || c.kpis.passed !== t.overall.passed || c.kpis.openDefects !== t.overall.openDefects) d.push('Project KPIs ≠ Overall Detailed Table totals');
    for (const mm of c.hierarchy) {
      const indep = c.charts.byMainModule[mm.mainModuleId];
      if (!indep) {
        d.push(`${mm.name}: charts missing`);
        continue;
      }
      const v = selectScope(t, rules, { mainModuleId: mm.mainModuleId });
      scopes.push({ label: mm.name, independent: indep, fromTable: v.charts, kpiTotal: v.kpis.totalTc });
    }
    for (const s of scopes) {
      d.push(...diffCharts(s.label, s.independent, s.fromTable));
      const p = s.independent.moduleByOverall;
      if (p.pass + p.failed + p.other !== p.total) d.push(`${s.label}: ${CHART_TITLES.moduleByOverall} slices ${p.pass + p.failed + p.other} ≠ Total TC ${p.total}`);
      if (p.total !== s.kpiTotal) d.push(`${s.label}: ${CHART_TITLES.moduleByOverall} total ≠ KPI Total Number of TC`);
      const reg = s.independent.moduleRegistration.reduce((a, g) => a + g.totalTc, 0);
      if (reg !== s.kpiTotal) d.push(`${s.label}: ${CHART_TITLES.moduleRegistration} sum ${reg} ≠ KPI ${s.kpiTotal}`);
      const oc = s.independent.openVsClosedByModule.reduce((a, g) => ({ o: a.o + g.Open, c: a.c + g.Closed }), { o: 0, c: 0 });
      if (oc.o !== s.independent.openVsClosed.Open || oc.c !== s.independent.openVsClosed.Closed) d.push(`${s.label}: ${CHART_TITLES.openVsClosedByModule} does not sum to ${CHART_TITLES.openVsClosed}`);
      for (const g of s.independent.dsiByModule) {
        const other = s.fromTable.dsiByModule.find((x) => x.id === g.id);
        if (JSON.stringify(other?.dsi) !== JSON.stringify(g.dsi)) dsiIssues.push(`${s.label}: ${CHART_TITLES.dsiByModule} ${g.name} mismatch`);
        if (rules.dsi && g.dsi.status === 'unavailable') dsiIssues.push(`${s.label} › ${g.name}: ${g.dsi.reason}`);
      }
    }
    gates.push(gate('VAL-004', 'Charts match the Overall Detailed Table', d, { scopesChecked: scopes.length, chartsPerScope: 7 }));
  }

  // VAL-004-DSI — the eighth chart; blocking once a DSI formula is approved (calc-v1 rule 3)
  {
    const approved = !!rules.dsi;
    gates.push({
      id: 'VAL-004-DSI',
      name: CHART_TITLES.dsiByModule,
      state: !approved ? 'Pending' : dsiIssues.length ? 'Failed' : 'Passed',
      blocking: approved,
      evidence: { formulaVersion: rules.dsi?.version ?? null },
      discrepancies: approved ? [...new Set(dsiIssues)] : ['DSI formula not approved — DSI shown as pending'],
    });
  }

  // VAL-005 — the synchronized dataset passes validation
  {
    const d: string[] = [];
    const issuesByCode: Record<string, number> = {};
    for (const i of input.issues) issuesByCode[i.code] = (issuesByCode[i.code] ?? 0) + 1;
    for (const i of input.issues.slice(0, 50)) d.push(`${i.lineage.sheetTitle}${i.lineage.row ? ` row ${i.lineage.row}` : ''}: ${i.message}`);
    if (input.issues.length > 50) d.push(`…and ${input.issues.length - 50} more record issues`);
    const inHierarchy = new Set(c.hierarchy.flatMap((m) => m.submodules.map((s) => `${m.mainModuleId}/${s.id}`)));
    for (const r of [...input.tests, ...input.defects]) if (r.projectId !== input.projectId) d.push(`Record from project ${r.projectId} in ${input.projectId} candidate`);
    const unregistered = new Set([...input.tests, ...input.defects].map((r) => `${r.mainModuleId}/${r.moduleId}`).filter((k) => !inHierarchy.has(k)));
    for (const k of unregistered) d.push(`Records reference unregistered or archived module ${k}`);
    if (input.modules.some((m) => m.projectId !== input.projectId)) d.push('Module registry contains another project’s modules');
    if (!c.rulesetVersion) d.push('Missing ruleset version');
    if (!c.mappingVersion) d.push('Missing mapping version');
    if (c.projectId !== input.projectId) d.push('Candidate project scope mismatch');
    gates.push(gate('VAL-005', 'Synchronized dataset is valid', d, { issuesByCode, rulesetVersion: c.rulesetVersion, mappingVersion: c.mappingVersion }));
  }

  const blockingOk = gates.every((g) => !g.blocking || g.state === 'Passed');
  const sourceFailed = input.sources.some((s) => s.state === 'failed');
  const runState: RunState = sourceFailed ? 'Sync Failed' : blockingOk ? 'Validated' : 'Validation Failed';
  const count = (codes: string[]) => input.issues.filter((i) => codes.includes(i.code)).length;
  return {
    projectId: input.projectId,
    gates,
    publishable: blockingOk && !sourceFailed,
    runState,
    counts: {
      duplicates: input.duplicates,
      conflicts: input.conflicts.length,
      missingIds: count(['MISSING_TEST_CASE_ID']),
      invalidStatuses: count(['UNMAPPED_STATUS', 'MISSING_STATUS', 'UNMAPPED_DEFECT_STATUS', 'MISSING_DEFECT_STATUS']),
      discrepancies: gates.filter((g) => g.blocking).reduce((a, g) => a + g.discrepancies.length, 0),
      quarantined: input.reviews.length,
    },
  };
}

/** Field-by-field comparison of two chart sets (charts 1–7). */
export function diffCharts(label: string, a: ChartData, b: ChartData): string[] {
  const d: string[] = [];
  const ids = (x: { id: string }[]) => x.map((g) => g.id).join(',');
  const lists: [keyof ChartData, string][] = [
    ['moduleRegistration', CHART_TITLES.moduleRegistration],
    ['testStatusByModule', CHART_TITLES.testStatusByModule],
    ['openVsClosedByModule', CHART_TITLES.openVsClosedByModule],
    ['severityByModule', CHART_TITLES.severityByModule],
    ['priorityByModule', CHART_TITLES.priorityByModule],
  ];
  for (const [k, title] of lists) {
    const x = a[k] as { id: string }[];
    const y = b[k] as { id: string }[];
    if (ids(x) !== ids(y)) {
      d.push(`${label}: ${title} categories differ from the table`);
      continue;
    }
    x.forEach((g, i) => {
      const h = y[i]!;
      const same = 'counts' in g ? sameCounts((g as unknown as { counts: CountMap }).counts, (h as unknown as { counts: CountMap }).counts) : JSON.stringify(g) === JSON.stringify(h);
      if (!same) d.push(`${label}: ${title} — ${(g as { name?: string }).name ?? g.id} mismatch`);
    });
  }
  if (JSON.stringify(a.moduleByOverall) !== JSON.stringify(b.moduleByOverall)) d.push(`${label}: ${CHART_TITLES.moduleByOverall} mismatch`);
  if (a.openVsClosed.Open !== b.openVsClosed.Open || a.openVsClosed.Closed !== b.openVsClosed.Closed) d.push(`${label}: ${CHART_TITLES.openVsClosed} mismatch`);
  return d;
}

function sameCounts(a: CountMap, b: CountMap): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

/** Freshness is an attribute, not a run state (§10 states). */
export function isStale(lastVerifiedAt: string | null, now: Date, thresholdMinutes: number): boolean {
  if (!lastVerifiedAt) return false;
  return now.getTime() - new Date(lastVerifiedAt).getTime() > thresholdMinutes * 60_000;
}
