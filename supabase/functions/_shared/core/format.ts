import type { DsiValue } from './types.ts';

/** Presentation-only rounding (BR-CALC-008). Null → "N/A", never a fabricated 0%. */
export function formatPercent(v: number | null, decimals = 1): string {
  return v === null ? 'N/A' : `${v.toFixed(decimals)}%`;
}

export function formatDsi(v: DsiValue, decimals = 2): string {
  if (v.status === 'unavailable') return 'Unavailable';
  return v.value === null ? 'N/A' : v.value.toFixed(decimals);
}

/** CSV cell escaping with spreadsheet formula-injection guard (SEC-007). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][], meta: [string, string][] = []): string {
  const lines = meta.map(([k, v]) => `${csvCell(k)},${csvCell(v)}`);
  if (lines.length) lines.push('');
  lines.push(header.map(csvCell).join(','));
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\r\n');
}
