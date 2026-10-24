import type { Cell, RawSheet } from './types.ts';

/** Minimal slice of the SheetJS API, injected so core stays dependency-free. */
export interface SheetJsLike {
  read(data: unknown, opts: Record<string, unknown>): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
    Workbook?: { Sheets?: { name: string; sheetId?: string; Hidden?: number }[] };
  };
  utils: { sheet_to_json(ws: unknown, opts: Record<string, unknown>): unknown[][] };
}

/**
 * Parse an XLSX/XLS/CSV payload into provider-neutral sheets. Uses the workbook.xml
 * sheetId as the stable worksheet identifier so renames keep module identity.
 * Formulas are read as cached values only; nothing is evaluated (SEC-007).
 */
export function parseWorkbook(XLSX: SheetJsLike, data: Uint8Array | ArrayBuffer): RawSheet[] {
  const wb = XLSX.read(data, { type: 'array', cellDates: true, cellFormula: false, cellHTML: false, sheetStubs: false, dense: false });
  const meta = wb.Workbook?.Sheets ?? [];
  return wb.SheetNames.map((name, i) => {
    const m = meta.find((s) => s.name === name) ?? meta[i];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) as Cell[][];
    return { sheetId: String(m?.sheetId ?? `idx-${i + 1}`), title: name, hidden: (m?.Hidden ?? 0) > 0, rows };
  });
}
