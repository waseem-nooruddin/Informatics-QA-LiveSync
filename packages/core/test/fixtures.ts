import * as XLSX from 'xlsx';
import { parseWorkbook, type SheetJsLike } from '../src/xlsx.ts';
import type { Cell, MainModuleEntry, RawWorkbook, SourceOutcome } from '../src/types.ts';

export const TC_HEADER = ['Test Case ID', 'Title', 'Status', 'Execution Date', 'Defect ID', 'Defect Status', 'Severity', 'Priority'];

export interface SheetSpec {
  name: string;
  rows: Cell[][];
  hidden?: boolean;
}

/** Build a real XLSX binary and parse it back, exercising the same path as adapters. */
export function xlsxBytes(sheets: SheetSpec[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
  wb.Workbook = wb.Workbook ?? {};
  wb.Workbook.Sheets = sheets.map((s) => ({ name: s.name, Hidden: s.hidden ? 1 : 0 }));
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export function workbook(projectId: string, fileId: string, sheets: SheetSpec[], mainModuleId = 'user-management', revision = 'r1'): RawWorkbook {
  return {
    projectId,
    mainModuleId,
    sourceId: `src-${fileId}`,
    provider: 'upload',
    fileId,
    fileName: `${fileId}.xlsx`,
    revision,
    modifiedAt: '2026-10-20T10:00:00.000Z',
    sheets: parseWorkbook(XLSX as unknown as SheetJsLike, xlsxBytes(sheets)),
  };
}

export const mainModules = (projectId: string, ...names: [string, string][]): MainModuleEntry[] =>
  names.map(([mainModuleId, name]) => ({ projectId, mainModuleId, name, active: true }));

export const okSource = (wb: RawWorkbook): SourceOutcome => ({
  sourceId: wb.sourceId,
  fileId: wb.fileId,
  fileName: wb.fileName,
  provider: wb.provider,
  state: 'read',
  revision: wb.revision,
});

/** n test cases with a given status distribution, optional inline defect columns per row. */
export function tcRows(prefix: string, statuses: string[], defects: Cell[][] = []): Cell[][] {
  return [TC_HEADER, ...statuses.map((s, i) => [`${prefix}-${String(i + 1).padStart(3, '0')}`, `Case ${i + 1}`, s, '2026-10-01', ...(defects[i] ?? [null, null, null, null])])];
}
