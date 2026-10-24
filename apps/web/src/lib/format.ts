export { formatDsi, formatPercent, isStale, toCsv } from '@qals/core';

const nf = new Intl.NumberFormat(undefined);
export const n = (v: number) => nf.format(v);

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function relative(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never';
  const s = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function download(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([`﻿${content}`], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
