import { detectHeader, type HeaderDetection } from './normalize.ts';
import type {
  CanonicalField,
  Conflict,
  DedupDecision,
  MainModuleEntry,
  MappingReview,
  ModuleEntry,
  ModuleId,
  ModuleMapping,
  ProjectId,
  RawSheet,
  RawWorkbook,
  Ruleset,
} from './types.ts';

export type SheetKind = 'module' | 'defects' | 'skipped';

export interface SheetClassification {
  kind: SheetKind;
  reason: string;
  header: HeaderDetection | null;
}

/** Only valid configured module tabs become submodules; summary/config sheets are excluded. */
export function classifySheet(
  sheet: RawSheet,
  rs: Ruleset,
  explicit?: Partial<Record<CanonicalField, string>>,
): SheetClassification {
  if (sheet.hidden) return { kind: 'skipped', reason: 'hidden sheet', header: null };
  const title = sheet.title.trim().toLowerCase();
  if (rs.excludedSheetPatterns.some((p) => new RegExp(p, 'i').test(title))) {
    return { kind: 'skipped', reason: 'excluded by sheet name rule', header: null };
  }
  const header = detectHeader(sheet, rs, explicit);
  if (!header) return { kind: 'skipped', reason: 'no recognizable header', header: null };
  const c = header.columns;
  if (c.testCaseId !== undefined && c.status !== undefined) return { kind: 'module', reason: 'test case columns mapped', header };
  if (c.defectId !== undefined && c.defectStatus !== undefined && c.module !== undefined) {
    return { kind: 'defects', reason: 'defect register columns mapped', header };
  }
  return { kind: 'skipped', reason: 'mandatory columns (Test Case ID + Status) not found', header };
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'module';
}

export const sheetKey = (fileId: string, sheetId: string): string => `${fileId}:${sheetId}`;

export interface DiscoveredSheet {
  workbook: RawWorkbook;
  sheet: RawSheet;
  header: HeaderDetection;
  mainModuleId: string;
  moduleId: ModuleId | null; // null for defect sheets
}

export type DiscoveryEvent =
  | { type: 'module-created'; mainModuleId: string; moduleId: ModuleId; name: string; sheet: string }
  | { type: 'sheet-renamed'; moduleId: ModuleId; from: string; to: string }
  | { type: 'sheet-skipped'; fileName: string; sheet: string; reason: string }
  | { type: 'sheet-missing'; moduleId: ModuleId; fileId: string; sheetId: string; sheetTitle: string };

export interface DiscoveryInput {
  projectId: ProjectId;
  workbooks: RawWorkbook[];
  /** fileIds whose read failed this run; their mappings are kept untouched. */
  failedFileIds: string[];
  mainModules: MainModuleEntry[];
  modules: ModuleEntry[];
  mappings: ModuleMapping[];
  rs: Ruleset;
  explicitColumns?: Record<string, Partial<Record<CanonicalField, string>>>;
  /** fileId:sheetId keys an administrator chose to ignore. */
  ignoredSheetKeys?: string[];
}

export interface DiscoveryResult {
  modules: ModuleEntry[];
  mappings: ModuleMapping[];
  moduleSheets: DiscoveredSheet[];
  defectSheets: DiscoveredSheet[];
  events: DiscoveryEvent[];
  conflicts: Conflict[];
  decisions: DedupDecision[];
  /** Ambiguous items held out of totals and navigation until an administrator decides. */
  reviews: MappingReview[];
}

/**
 * Register submodules from module sheets using stable (fileId, sheetId) identity, scoped to the
 * main module each source is attached to (SRS V1.5 §5.2). Never deletes; never guesses: a new
 * tab whose name collides with an existing submodule is quarantined for review (AT-10).
 */
export function discover(input: DiscoveryInput): DiscoveryResult {
  const { projectId, rs } = input;
  for (const wb of input.workbooks) {
    if (wb.projectId !== projectId) throw new Error(`Workbook ${wb.fileId} belongs to ${wb.projectId}, not ${projectId}`);
  }
  const activeMain = new Set(input.mainModules.filter((m) => m.projectId === projectId && m.active).map((m) => m.mainModuleId));
  const modules = new Map(input.modules.filter((m) => m.projectId === projectId).map((m) => [m.moduleId, { ...m }]));
  const mappings = new Map(input.mappings.filter((m) => m.projectId === projectId).map((m) => [sheetKey(m.fileId, m.sheetId), { ...m }]));
  const ignored = new Set(input.ignoredSheetKeys ?? []);
  const findByName = (mainModuleId: string, name: string) =>
    [...modules.values()].find((m) => m.mainModuleId === mainModuleId && m.name.trim().toLowerCase() === name.trim().toLowerCase());

  const result: DiscoveryResult = { modules: [], mappings: [], moduleSheets: [], defectSheets: [], events: [], conflicts: [], decisions: [], reviews: [] };
  const seen = new Set<string>();

  for (const wb of input.workbooks) {
    if (!activeMain.has(wb.mainModuleId)) {
      result.reviews.push({
        kind: 'unknown-main-module', key: `${projectId}|${wb.fileId}`, projectId, mainModuleId: wb.mainModuleId, fileId: wb.fileId, sheetId: null,
        title: wb.fileName, detail: `“${wb.fileName}” is attached to a main module that is not active in this project`,
      });
      continue;
    }
    for (const sheet of wb.sheets) {
      const key = sheetKey(wb.fileId, sheet.sheetId);
      if (ignored.has(key)) {
        result.events.push({ type: 'sheet-skipped', fileName: wb.fileName, sheet: sheet.title, reason: 'ignored by administrator' });
        continue;
      }
      const cls = classifySheet(sheet, rs, input.explicitColumns?.[key]);
      if (cls.kind === 'skipped') {
        result.events.push({ type: 'sheet-skipped', fileName: wb.fileName, sheet: sheet.title, reason: cls.reason });
        continue;
      }
      if (cls.kind === 'defects') {
        result.defectSheets.push({ workbook: wb, sheet, header: cls.header!, mainModuleId: wb.mainModuleId, moduleId: null });
        continue;
      }
      let mapping = mappings.get(key);
      if (mapping) {
        if (mapping.sheetTitle !== sheet.title) {
          result.events.push({ type: 'sheet-renamed', moduleId: mapping.moduleId, from: mapping.sheetTitle, to: sheet.title });
          mapping.sheetTitle = sheet.title;
        }
      } else {
        const existing = findByName(wb.mainModuleId, sheet.title);
        if (existing && !rs.sourcePrecedence[existing.moduleId]?.includes(key)) {
          result.reviews.push({
            kind: 'submodule-name-collision', key: `${projectId}|${key}`, projectId, mainModuleId: wb.mainModuleId, fileId: wb.fileId, sheetId: sheet.sheetId,
            title: sheet.title, candidateModuleId: existing.moduleId,
            detail: `New tab “${sheet.title}” in ${wb.fileName} matches existing submodule “${existing.name}” — confirm whether it is the same submodule, a new one, or should be ignored`,
          });
          continue;
        }
        let moduleId: ModuleId;
        if (existing) {
          moduleId = existing.moduleId; // approved precedence: same logical submodule
        } else {
          moduleId = uniqueId(slugify(sheet.title), modules);
          modules.set(moduleId, { projectId, mainModuleId: wb.mainModuleId, moduleId, name: sheet.title.trim(), active: true });
          result.events.push({ type: 'module-created', mainModuleId: wb.mainModuleId, moduleId, name: sheet.title.trim(), sheet: key });
        }
        mapping = { projectId, mainModuleId: wb.mainModuleId, moduleId, sourceId: wb.sourceId, fileId: wb.fileId, sheetId: sheet.sheetId, sheetTitle: sheet.title };
        mappings.set(key, mapping);
      }
      seen.add(key);
      result.moduleSheets.push({ workbook: wb, sheet, header: cls.header!, mainModuleId: mapping.mainModuleId, moduleId: mapping.moduleId });
    }
  }

  // Missing sheets on files that were read successfully → source issue, submodule retained (V1.5 §5.2).
  const readFiles = new Set(input.workbooks.map((w) => w.fileId));
  for (const m of mappings.values()) {
    const mod = modules.get(m.moduleId);
    if (!mod?.active || !activeMain.has(mod.mainModuleId)) continue;
    const k = sheetKey(m.fileId, m.sheetId);
    if (readFiles.has(m.fileId) && !seen.has(k) && !ignored.has(k)) {
      result.events.push({ type: 'sheet-missing', moduleId: m.moduleId, fileId: m.fileId, sheetId: m.sheetId, sheetTitle: m.sheetTitle });
    }
  }

  // Source ownership: one owning sheet per submodule unless an approved precedence exists.
  const owners = new Map<ModuleId, DiscoveredSheet[]>();
  for (const s of result.moduleSheets) owners.set(s.moduleId!, [...(owners.get(s.moduleId!) ?? []), s]);
  const kept: DiscoveredSheet[] = [];
  for (const [moduleId, sheets] of owners) {
    if (sheets.length === 1) {
      kept.push(sheets[0]!);
      continue;
    }
    const order = rs.sourcePrecedence[moduleId];
    const keys = sheets.map((s) => sheetKey(s.workbook.fileId, s.sheet.sheetId));
    const winner = order?.find((k) => keys.includes(k));
    if (winner && keys.every((k) => order!.includes(k))) {
      kept.push(sheets[keys.indexOf(winner)]!);
      result.decisions.push({ kind: 'module-precedence', key: `${projectId}|${moduleId}`, kept: winner, superseded: keys.filter((k) => k !== winner), reason: 'approved source precedence' });
    } else {
      kept.push(...sheets);
      result.conflicts.push({
        kind: 'module-ownership', key: `${projectId}|${moduleId}`, moduleId,
        detail: `Submodule “${modules.get(moduleId)?.name}” is supplied by ${sheets.length} sheets with no approved precedence`, refs: keys,
      });
    }
  }
  result.moduleSheets = kept;
  result.modules = [...modules.values()];
  result.mappings = [...mappings.values()];
  return result;
}

function uniqueId(base: string, modules: Map<ModuleId, ModuleEntry>): ModuleId {
  if (!modules.has(base)) return base;
  let i = 2;
  while (modules.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
