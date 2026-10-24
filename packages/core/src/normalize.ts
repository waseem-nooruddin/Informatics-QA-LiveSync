import type {
  CanonicalField,
  Cell,
  DefectLifecycle,
  DefectRecord,
  Lineage,
  ModuleId,
  ProjectId,
  RawSheet,
  RecordIssue,
  Ruleset,
  TestRecord,
  TestStatus,
} from './types.ts';

/** Trim, collapse internal whitespace, lowercase. Used only for matching keys. */
export function normKey(v: Cell): string {
  return cellText(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Display-safe text of a cell; original evidence is never mutated. */
export function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

/** Canonical identifier form: trimmed, inner whitespace collapsed, upper-cased. */
export function normId(v: Cell): string {
  return cellText(v).replace(/\s+/g, ' ').trim().toUpperCase();
}

export function mapTestStatus(v: Cell, rs: Ruleset): TestStatus | null {
  return rs.testStatusAliases[normKey(v)] ?? null;
}

export function mapDefectStatus(v: Cell, rs: Ruleset): DefectLifecycle | null {
  return rs.defectStatusAliases[normKey(v)] ?? null;
}

export function mapCategory(
  v: Cell,
  categories: string[],
  aliases: Record<string, string>,
): string | null | undefined {
  const k = normKey(v);
  if (!k) return null; // blank: absent
  const direct = categories.find((c) => c.toLowerCase() === k);
  if (direct) return direct;
  return aliases[k]; // undefined = unknown value
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Parse a date cell to ISO-8601. Returns undefined for unparseable, null for blank. */
export function parseDate(v: Cell, order: Ruleset['dateOrder']): string | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.toISOString();
  if (typeof v === 'number') {
    if (v < 1 || v > 2958465) return undefined;
    return new Date(EXCEL_EPOCH + Math.round(v * 86400000)).toISOString();
  }
  const s = cellText(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    const [, y, m, d, hh = '0', mm = '0', ss = '0'] = iso;
    return utc(+y!, +m!, +d!, +hh, +mm, +ss);
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dmy) {
    const [, a, b, yRaw, hh = '0', mm = '0', ss = '0'] = dmy;
    const y = yRaw!.length === 2 ? 2000 + +yRaw! : +yRaw!;
    const [d, m] = order === 'DMY' ? [+a!, +b!] : [+b!, +a!];
    return utc(y, m, d, +hh, +mm, +ss);
  }
  return undefined;
}

function utc(y: number, m: number, d: number, hh: number, mm: number, ss: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  if (t.getUTCDate() !== d) return undefined;
  return t.toISOString();
}

export type HeaderMap = Partial<Record<CanonicalField, number>>;

export interface HeaderDetection {
  headerRow: number; // 0-based index into rows
  columns: HeaderMap;
  ambiguous: CanonicalField[];
}

/**
 * Find the header row (within the first 10 rows) mapping the most canonical fields.
 * An explicit mapping (header text -> field) takes precedence over aliases (FR-MAP-002).
 */
export function detectHeader(
  sheet: RawSheet,
  rs: Ruleset,
  explicit?: Partial<Record<CanonicalField, string>>,
): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  let bestScore = 0;
  const limit = Math.min(sheet.rows.length, 10);
  for (let r = 0; r < limit; r++) {
    const row = sheet.rows[r] ?? [];
    const cols: HeaderMap = {};
    const ambiguous: CanonicalField[] = [];
    const keys = row.map(normKey);
    for (const field of Object.keys(rs.columnAliases) as CanonicalField[]) {
      const wanted = explicit?.[field] ? [normKey(explicit[field]!)] : rs.columnAliases[field];
      const hits = keys.flatMap((k, i) => (k && wanted.includes(k) ? [i] : []));
      if (hits.length === 1) cols[field] = hits[0]!;
      else if (hits.length > 1) {
        // prefer the most specific alias (earliest in alias list)
        const ranked = [...hits].sort((x, y) => wanted.indexOf(keys[x]!) - wanted.indexOf(keys[y]!));
        if (wanted.indexOf(keys[ranked[0]!]!) === wanted.indexOf(keys[ranked[1]!]!)) ambiguous.push(field);
        else cols[field] = ranked[0]!;
      }
    }
    // A bare "Status" column on a defect sheet is the defect status.
    if (cols.defectId !== undefined && cols.testCaseId === undefined && cols.defectStatus === undefined && cols.status !== undefined) {
      cols.defectStatus = cols.status;
      delete cols.status;
    }
    const score = Object.keys(cols).length;
    if (score > bestScore) {
      bestScore = score;
      best = { headerRow: r, columns: cols, ambiguous };
    }
  }
  return best;
}

export interface NormalizeContext {
  projectId: ProjectId;
  sourceId: string;
  fileId: string;
  sheet: RawSheet;
  header: HeaderDetection;
  rs: Ruleset;
  /** Main module the source is attached to; all records inherit it. */
  mainModuleId: string;
  /** Submodule for module sheets; for defect sheets resolved per row from the Module column (within the main module). */
  moduleId: ModuleId | null;
  resolveModule?: (name: string) => ModuleId | null;
}

export interface NormalizedSheet {
  tests: TestRecord[];
  defects: DefectRecord[];
  issues: RecordIssue[];
  rowsRead: number;
}

function isBlankRow(row: Cell[]): boolean {
  return row.every((c) => cellText(c) === '');
}

export function normalizeSheet(ctx: NormalizeContext): NormalizedSheet {
  const { sheet, header, rs } = ctx;
  const c = header.columns;
  const out: NormalizedSheet = { tests: [], defects: [], issues: [], rowsRead: 0 };
  const base = { sourceId: ctx.sourceId, fileId: ctx.fileId, sheetId: sheet.sheetId, sheetTitle: sheet.title };
  const get = (row: Cell[], f: CanonicalField): Cell => (c[f] === undefined ? null : row[c[f]!]);

  for (const f of header.ambiguous) {
    out.issues.push({ code: 'AMBIGUOUS_HEADER', message: `Ambiguous column for ${f}; approve a mapping`, lineage: base });
  }

  for (let r = header.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (isBlankRow(row)) continue;
    out.rowsRead++;
    const lineage: Lineage = { ...base, row: r + 1 };

    let moduleId = ctx.moduleId;
    if (!moduleId) {
      const name = cellText(get(row, 'module'));
      moduleId = name && ctx.resolveModule ? ctx.resolveModule(name) : null;
      if (!moduleId) {
        out.issues.push({ code: 'UNKNOWN_MODULE', message: `Submodule "${name}" is not registered in this main module`, value: name, lineage });
        continue;
      }
    }

    // Test case portion
    if (c.testCaseId !== undefined) {
      const tcId = normId(get(row, 'testCaseId'));
      const rawStatus = get(row, 'status');
      const hasTestData = tcId !== '' || cellText(rawStatus) !== '';
      if (hasTestData) {
        if (!tcId) {
          out.issues.push({ code: 'MISSING_TEST_CASE_ID', message: 'Row has a status but no Test Case ID', moduleId, lineage });
        } else if (cellText(rawStatus) === '') {
          out.issues.push({ code: 'MISSING_STATUS', message: `Test case ${tcId} has no status`, value: tcId, moduleId, lineage });
        } else {
          const status = mapTestStatus(rawStatus, rs);
          if (!status) {
            out.issues.push({ code: 'UNMAPPED_STATUS', message: `Unmapped test status "${cellText(rawStatus)}"`, value: cellText(rawStatus), moduleId, lineage });
          } else {
            let executedAt: string | null = null;
            if (c.executedAt !== undefined) {
              const d = parseDate(get(row, 'executedAt'), rs.dateOrder);
              if (d === undefined) {
                out.issues.push({ code: 'INVALID_DATE', message: `Invalid execution date "${cellText(get(row, 'executedAt'))}"`, moduleId, lineage });
              } else executedAt = d;
            }
            out.tests.push({ projectId: ctx.projectId, mainModuleId: ctx.mainModuleId, moduleId, testCaseId: tcId, status, executedAt, lineage });
          }
        }
      }
    }

    // Defect portion (inline on module sheets, or a dedicated defect sheet)
    if (c.defectId !== undefined) {
      const ids = cellText(get(row, 'defectId'))
        .split(/[,;\n]+/)
        .map((s) => normId(s))
        .filter(Boolean);
      if (ids.length === 0) continue;
      const rawStatus = get(row, 'defectStatus');
      if (cellText(rawStatus) === '') {
        out.issues.push({ code: 'MISSING_DEFECT_STATUS', message: `Defect ${ids.join(', ')} has no status`, value: ids.join(','), moduleId, lineage });
        continue;
      }
      const lifecycle = mapDefectStatus(rawStatus, rs);
      if (!lifecycle) {
        out.issues.push({ code: 'UNMAPPED_DEFECT_STATUS', message: `Unmapped defect status "${cellText(rawStatus)}"`, value: cellText(rawStatus), moduleId, lineage });
        continue;
      }
      const severity = mapCategory(get(row, 'severity'), rs.severityCategories, rs.severityAliases);
      const priority = mapCategory(get(row, 'priority'), rs.priorityCategories, rs.priorityAliases);
      if (severity === undefined) {
        out.issues.push({ code: 'UNKNOWN_SEVERITY', message: `Unknown severity "${cellText(get(row, 'severity'))}"`, value: cellText(get(row, 'severity')), moduleId, lineage });
        continue;
      }
      if (priority === undefined) {
        out.issues.push({ code: 'UNKNOWN_PRIORITY', message: `Unknown priority "${cellText(get(row, 'priority'))}"`, value: cellText(get(row, 'priority')), moduleId, lineage });
        continue;
      }
      for (const defectId of ids) {
        out.defects.push({ projectId: ctx.projectId, mainModuleId: ctx.mainModuleId, moduleId, defectId, lifecycle, rawStatus: cellText(rawStatus), severity, priority, lineage });
      }
    }
  }
  return out;
}
