import { buildChartSet, buildHierarchy, buildTable, independentCounts, kpisOf, type IndependentCounts } from './aggregate.ts';
import { dedupe, type CanonicalTest } from './dedup.ts';
import { discover, sheetKey, type DiscoveryResult } from './discovery.ts';
import { normId, normalizeSheet } from './normalize.ts';
import type {
  CandidateSnapshot,
  CanonicalField,
  DefectRecord,
  MainModuleEntry,
  ModuleEntry,
  ModuleMapping,
  ProjectId,
  RawWorkbook,
  RecordIssue,
  Ruleset,
  SourceOutcome,
  TestRecord,
  ValidationReport,
} from './types.ts';
import { validate, type ValidationInput } from './validate.ts';

export interface PipelineInput {
  projectId: ProjectId;
  rs: Ruleset;
  mappingVersion: string;
  /** Workbooks read (or reused from cache) this run. All must belong to projectId. */
  workbooks: RawWorkbook[];
  sources: SourceOutcome[];
  mainModules: MainModuleEntry[];
  modules: ModuleEntry[];
  mappings: ModuleMapping[];
  explicitColumns?: Record<string, Partial<Record<CanonicalField, string>>>;
  ignoredSheetKeys?: string[];
  previousModuleTc?: Record<string, number>;
  /** Extra independent count paths (e.g. SQL reconcile) supplied by the backend. */
  extraIndependent?: { label: string; counts: IndependentCounts }[];
  now?: Date;
}

export interface PipelineResult {
  discovery: DiscoveryResult;
  tests: CanonicalTest[];
  defects: DefectRecord[];
  rawTests: TestRecord[];
  rawDefects: DefectRecord[];
  issues: RecordIssue[];
  candidate: CandidateSnapshot;
  report: ValidationReport;
  /** Inputs to `validate`, so a caller can re-run the gates with extra independent paths. */
  validationInput: ValidationInput;
}

/** Read → discover → normalize → dedup → aggregate → validate, for exactly one project. */
export function runPipeline(input: PipelineInput): PipelineResult {
  const { projectId, rs } = input;
  const discovery = discover({
    projectId,
    workbooks: input.workbooks,
    failedFileIds: input.sources.filter((s) => s.state === 'failed').map((s) => s.fileId),
    mainModules: input.mainModules,
    modules: input.modules,
    mappings: input.mappings,
    rs,
    explicitColumns: input.explicitColumns,
    ignoredSheetKeys: input.ignoredSheetKeys,
  });

  // Defect-register "Module" values resolve only within the sheet's own main module.
  const resolverFor = (mainModuleId: string) => {
    const names = new Map<string, string>();
    for (const m of discovery.modules) {
      if (m.mainModuleId !== mainModuleId) continue;
      names.set(m.name.trim().toLowerCase(), m.moduleId);
      names.set(m.moduleId, m.moduleId);
    }
    return (name: string) => names.get(name.trim().toLowerCase()) ?? names.get(normId(name).toLowerCase()) ?? null;
  };

  const rawTests: TestRecord[] = [];
  const rawDefects: DefectRecord[] = [];
  const issues: RecordIssue[] = [];
  for (const s of [...discovery.moduleSheets, ...discovery.defectSheets]) {
    const n = normalizeSheet({
      projectId,
      sourceId: s.workbook.sourceId,
      fileId: s.workbook.fileId,
      sheet: s.sheet,
      header: s.header,
      rs,
      mainModuleId: s.mainModuleId,
      moduleId: s.moduleId,
      resolveModule: resolverFor(s.mainModuleId),
    });
    rawTests.push(...n.tests);
    rawDefects.push(...n.defects);
    issues.push(...n.issues);
  }

  const dd = dedupe(rawTests, rawDefects);
  const lastSourceUpdate: Record<string, string | null> = {};
  for (const wb of input.workbooks) lastSourceUpdate[wb.fileId] = wb.modifiedAt;

  const hierarchy = buildHierarchy(input.mainModules.filter((m) => m.projectId === projectId), discovery.modules);
  const table = buildTable({ tests: dd.tests, defects: dd.defects, hierarchy, mappings: discovery.mappings, rs, lastSourceUpdate });
  const charts = buildChartSet(dd.tests, dd.defects, hierarchy, rs);
  const now = input.now ?? new Date();
  const candidate: CandidateSnapshot = {
    projectId,
    rulesetVersion: rs.version,
    rulesetProvisional: rs.provisional,
    mappingVersion: input.mappingVersion,
    sourceCutoff: now.toISOString(),
    hierarchy,
    table,
    charts,
    kpis: kpisOf(table.overall),
    sources: input.sources,
  };
  const active = hierarchy.flatMap((m) => m.submodules.map((s) => s.id));
  const validationInput: ValidationInput = {
    projectId,
    candidate,
    rules: rs,
    sources: input.sources,
    discoveryEvents: discovery.events,
    conflicts: [...discovery.conflicts, ...dd.conflicts],
    reviews: discovery.reviews,
    duplicates: dd.duplicates,
    decisions: dd.decisions.length + discovery.decisions.length,
    issues,
    tests: dd.tests,
    defects: dd.defects,
    modules: discovery.modules,
    independent: [{ label: 'ts-independent', counts: independentCounts(dd.tests, dd.defects, active) }, ...(input.extraIndependent ?? [])],
    previousModuleTc: input.previousModuleTc,
  };
  const report = validate(validationInput);
  return { discovery, tests: dd.tests, defects: dd.defects, rawTests, rawDefects, issues, candidate, report, validationInput };
}

export { sheetKey };
