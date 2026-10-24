// Canonical entities and contracts (SRS V1.5 §6). Every project-owned record carries an
// immutable projectId plus stable parent ids: Project → Main Module → Submodule.

export type ProjectId = string;
export type MainModuleId = string;
/** Submodule id — unique within a project. */
export type ModuleId = string;

export const TEST_STATUSES = ['Passed', 'Failed', 'Blocked', 'Not Tested'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const DEFECT_LIFECYCLES = ['Open', 'Closed'] as const;
export type DefectLifecycle = (typeof DEFECT_LIFECYCLES)[number];

export type Provider = 'google-sheets' | 'google-drive-xlsx' | 'onedrive' | 'upload';

export type CanonicalField =
  | 'testCaseId'
  | 'status'
  | 'executedAt'
  | 'module'
  | 'defectId'
  | 'defectStatus'
  | 'severity'
  | 'priority';

/** Provider-neutral cell value as delivered by an adapter. */
export type Cell = string | number | boolean | Date | null | undefined;

export interface RawSheet {
  /** Stable provider identifier (Google sheetId, XLSX workbook.xml sheetId). */
  sheetId: string;
  title: string;
  hidden: boolean;
  rows: Cell[][];
}

export interface RawWorkbook {
  projectId: ProjectId;
  /** The main module this source was attached to (+ Add, or its project subfolder). */
  mainModuleId: MainModuleId;
  sourceId: string;
  provider: Provider;
  fileId: string;
  fileName: string;
  revision: string;
  modifiedAt: string | null;
  sheets: RawSheet[];
}

export type SourceReadState = 'read' | 'unchanged' | 'failed';

export interface SourceOutcome {
  sourceId: string;
  fileId: string;
  fileName: string;
  provider: Provider;
  state: SourceReadState;
  revision: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface Lineage {
  sourceId: string;
  fileId: string;
  sheetId: string;
  sheetTitle: string;
  /** 1-based spreadsheet row number. */
  row: number;
}

export interface MainModuleEntry {
  projectId: ProjectId;
  mainModuleId: MainModuleId;
  name: string;
  active: boolean;
}

export interface ModuleMapping {
  projectId: ProjectId;
  mainModuleId: MainModuleId;
  moduleId: ModuleId;
  sourceId: string;
  fileId: string;
  sheetId: string;
  sheetTitle: string;
}

/** A submodule. */
export interface ModuleEntry {
  projectId: ProjectId;
  mainModuleId: MainModuleId;
  moduleId: ModuleId;
  name: string;
  active: boolean;
}

export interface TestRecord {
  projectId: ProjectId;
  mainModuleId: MainModuleId;
  moduleId: ModuleId;
  testCaseId: string;
  status: TestStatus;
  executedAt: string | null;
  lineage: Lineage;
}

export interface DefectRecord {
  projectId: ProjectId;
  mainModuleId: MainModuleId;
  moduleId: ModuleId;
  defectId: string;
  lifecycle: DefectLifecycle;
  rawStatus: string;
  severity: string | null;
  priority: string | null;
  lineage: Lineage;
}

export type IssueCode =
  | 'MISSING_TEST_CASE_ID'
  | 'MISSING_STATUS'
  | 'UNMAPPED_STATUS'
  | 'UNMAPPED_DEFECT_STATUS'
  | 'MISSING_DEFECT_STATUS'
  | 'UNKNOWN_SEVERITY'
  | 'UNKNOWN_PRIORITY'
  | 'UNKNOWN_MODULE'
  | 'INVALID_DATE'
  | 'AMBIGUOUS_HEADER'
  | 'PROJECT_SCOPE_MISMATCH'
  | 'UNREGISTERED_MODULE';

export interface RecordIssue {
  code: IssueCode;
  message: string;
  value?: string;
  moduleId?: ModuleId;
  lineage: Omit<Lineage, 'row'> & { row?: number };
}

export interface DefectPopulation {
  severity: 'all' | 'open';
  priority: 'all' | 'open';
}

export interface DsiFormula {
  version: string;
  /** Weight per canonical severity category. */
  weights: Record<string, number>;
  population: 'all' | 'open';
  denominator: 'none' | 'totalTc' | 'defects';
  missingSeverity: 'fail' | 'exclude';
  decimals: number;
}

export interface Ruleset {
  version: string;
  provisional: boolean;
  testStatusAliases: Record<string, TestStatus>;
  defectStatusAliases: Record<string, DefectLifecycle>;
  severityCategories: string[];
  severityAliases: Record<string, string>;
  priorityCategories: string[];
  priorityAliases: Record<string, string>;
  columnAliases: Record<CanonicalField, string[]>;
  excludedSheetPatterns: string[];
  dateOrder: 'DMY' | 'MDY';
  passRatioDenominator: 'totalTc';
  /** "Other" in Module by OverAll. */
  otherStatuses: TestStatus[];
  defectPopulation: DefectPopulation;
  dsi: DsiFormula | null;
  /** moduleId -> ordered fileId:sheetId owners; first wins. Empty = one owner required. */
  sourcePrecedence: Record<ModuleId, string[]>;
  staleThresholdMinutes: number;
}

export type GateId = 'VAL-001' | 'VAL-002' | 'VAL-003' | 'VAL-004' | 'VAL-005';
export type GateState = 'Passed' | 'Failed' | 'Pending';

export interface GateResult {
  id: GateId | 'VAL-004-DSI';
  name: string;
  state: GateState;
  blocking: boolean;
  evidence: Record<string, unknown>;
  discrepancies: string[];
}

export type RunState = 'Pending' | 'Validating' | 'Validated' | 'Validation Failed' | 'Sync Failed';

export type CountMap = Record<string, number>;

export type DsiValue =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; value: number | null; formulaVersion: string };

/** Raw DSI components so any scope (submodule selection) can be recombined exactly. */
export interface DsiParts {
  weighted: number;
  count: number;
  /** Set when the formula could not be applied (e.g. missing severity). */
  error?: string;
}

export interface Counts {
  totalTc: number;
  passed: number;
  failed: number;
  blocked: number;
  notTested: number;
  openDefects: number;
  closedDefects: number;
  severity: CountMap;
  priority: CountMap;
  dsiParts: DsiParts;
}

/** One Overall Detailed Table row: a submodule. */
export interface ModuleRow extends Counts {
  mainModuleId: MainModuleId;
  mainModuleName: string;
  moduleId: ModuleId;
  moduleName: string;
  passRatio: number | null;
  dsi: DsiValue;
  sources: { sourceId: string; fileId: string; sheetId: string; sheetTitle: string }[];
  lastSourceUpdate: string | null;
}

export interface TotalRow extends Counts {
  passRatio: number | null;
  dsi: DsiValue;
  moduleCount: number;
}

export interface Kpis {
  totalTc: number;
  passed: number;
  openDefects: number;
  passRatio: number | null;
}

/** A chart category: a submodule (main-module scope) or a main module (project scope). */
export interface Group {
  id: string;
  name: string;
}

export interface ChartData {
  /** 1 · Module Registration by Total Number of TC */
  moduleRegistration: (Group & { totalTc: number })[];
  /** 2 · Module by OverAll */
  moduleByOverall: { pass: number; failed: number; other: number; total: number };
  /** 3 · Test Status by Module (counts; percentages derived at display, rows sum to 100%) */
  testStatusByModule: (Group & { Passed: number; Failed: number; Blocked: number; 'Not Tested': number })[];
  /** 4 · Total Open Defects vs. Closed Defects */
  openVsClosed: { Open: number; Closed: number };
  /** 5 · Total Open Defects vs. Closed Defects by Module */
  openVsClosedByModule: (Group & { Open: number; Closed: number })[];
  /** 6 · Defect Severity By Module */
  severityByModule: (Group & { counts: CountMap })[];
  /** 7 · Defect Priority by Module */
  priorityByModule: (Group & { counts: CountMap })[];
  /** 8 · DSI by Module */
  dsiByModule: (Group & { dsi: DsiValue })[];
}

export interface HierarchyNode {
  mainModuleId: MainModuleId;
  name: string;
  submodules: Group[];
}

export interface TableData {
  rows: ModuleRow[];
  mainModules: (TotalRow & { mainModuleId: MainModuleId; name: string })[];
  overall: TotalRow;
}

export interface DedupDecision {
  kind: 'test-duplicate' | 'test-latest-status' | 'defect-duplicate' | 'module-precedence';
  key: string;
  kept: Lineage | string;
  superseded: (Lineage | string)[];
  reason: string;
}

export interface Conflict {
  kind: 'test-status' | 'test-multi-submodule' | 'defect-attributes' | 'defect-module' | 'module-ownership';
  key: string;
  moduleId?: ModuleId;
  detail: string;
  refs: (Lineage | string)[];
}

/** Ambiguous discovery outcome held for an administrator's decision (SRS V1.5 §5.2). */
export interface MappingReview {
  kind: 'submodule-name-collision' | 'unknown-main-module' | 'unknown-folder';
  key: string;
  projectId: ProjectId;
  mainModuleId: MainModuleId | null;
  fileId: string;
  sheetId: string | null;
  title: string;
  detail: string;
  candidateModuleId?: ModuleId;
}

export interface CandidateSnapshot {
  projectId: ProjectId;
  rulesetVersion: string;
  rulesetProvisional: boolean;
  mappingVersion: string;
  sourceCutoff: string;
  hierarchy: HierarchyNode[];
  table: TableData;
  /** Independently computed from canonical records: project scope (by main module) and each main module (by submodule). */
  charts: { project: ChartData; byMainModule: Record<MainModuleId, ChartData> };
  kpis: Kpis;
  sources: SourceOutcome[];
}

export interface ValidationReport {
  projectId: ProjectId;
  gates: GateResult[];
  publishable: boolean;
  runState: RunState;
  counts: {
    duplicates: number;
    conflicts: number;
    missingIds: number;
    invalidStatuses: number;
    discrepancies: number;
    quarantined: number;
  };
}
