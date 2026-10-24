import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { combineCounts, totalRow, type CountMap, type DsiValue } from '@qals/core';
import { formatPercent, n } from '../lib/format';
import type { PublicModuleRow, PublicRules, TotalRow } from '../lib/types';
import { inputCls } from './ui';

function breakdown(counts: CountMap, cats: string[]): string {
  const keys = [...cats, ...Object.keys(counts).filter((k) => !cats.includes(k))];
  const parts = keys.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${k} ${counts[k]}`);
  return parts.length ? parts.join(' · ') : '—';
}
const dsiText = (v: DsiValue, d: number) => (v.status === 'unavailable' ? 'Unavailable' : v.value === null ? 'N/A' : v.value.toFixed(d));

/**
 * Overall Detailed Table (approved calc-v1): grouped Project › Main module › Submodule with
 * main-module subtotals and a scope total. Counts are read-only and come from the same snapshot
 * rows as every KPI and chart.
 */
export function ModuleTable({
  projectId,
  projectName,
  rows,
  total,
  rules,
  snapshotVersion,
  validationState,
  compact = false,
}: {
  projectId: string;
  projectName: string;
  rows: PublicModuleRow[];
  total: TotalRow;
  rules: PublicRules;
  snapshotVersion: number;
  validationState: string;
  compact?: boolean;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = compact ? 8 : 25;
  const d = rules.dsi?.decimals ?? 2;

  const columns = useMemo<ColumnDef<PublicModuleRow>[]>(
    () => [
      { id: 'moduleName', header: 'Submodule', accessorFn: (r) => r.moduleName },
      { id: 'totalTc', header: 'Total TC', accessorKey: 'totalTc' },
      { id: 'passed', header: 'Passed', accessorKey: 'passed' },
      { id: 'failed', header: 'Failed', accessorKey: 'failed' },
      { id: 'blocked', header: 'Blocked', accessorKey: 'blocked' },
      { id: 'notTested', header: 'Not Tested', accessorKey: 'notTested' },
      { id: 'passRatio', header: 'Test Pass Ratio', accessorFn: (r) => r.passRatio ?? -1, cell: (c) => formatPercent(c.row.original.passRatio) },
      { id: 'openDefects', header: 'Open Defects', accessorKey: 'openDefects' },
      { id: 'closedDefects', header: 'Closed Defects', accessorKey: 'closedDefects' },
      ...(compact
        ? []
        : ([
            { id: 'severity', header: 'Defect Severity', enableSorting: false, cell: (c) => breakdown(c.row.original.severity, rules.severityCategories) },
            { id: 'priority', header: 'Defect Priority', enableSorting: false, cell: (c) => breakdown(c.row.original.priority, rules.priorityCategories) },
            { id: 'dsi', header: 'DSI', accessorFn: (r) => (r.dsi.status === 'ok' ? (r.dsi.value ?? -1) : -2), cell: (c) => dsiText(c.row.original.dsi, d) },
            { id: 'source', header: 'Source Document / Sheet', enableSorting: false, cell: (c) => c.row.original.sources.map((s) => s.sheetTitle).join(', ') || '—' },
            { id: 'lastSync', header: 'Last Sync / Snapshot', enableSorting: false, cell: (c) => `${c.row.original.lastSourceUpdate ? new Date(c.row.original.lastSourceUpdate).toLocaleDateString() : '—'} · v${snapshotVersion}` },
            { id: 'status', header: 'Validation Status', enableSorting: false, cell: () => validationState },
          ] as ColumnDef<PublicModuleRow>[])),
    ],
    [compact, rules, d, snapshotVersion, validationState],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    // Rows always stay grouped under their main module; user sorting applies within a group.
    globalFilterFn: (row, _id, value: string) => `${row.original.mainModuleName} ${row.original.moduleName}`.toLowerCase().includes(String(value).toLowerCase()),
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Group first (stable sort keeps the user's ordering within each main module), then paginate.
  const grouped = table.getSortedRowModel().rows.slice().sort((a, b) => a.original.mainModuleName.localeCompare(b.original.mainModuleName));
  const pageCount = Math.max(1, Math.ceil(grouped.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = grouped.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const filteredAll = table.getFilteredRowModel().rows.map((r) => r.original);
  const groupTotal = (mainModuleId: string) => {
    const members = filteredAll.filter((r) => r.mainModuleId === mainModuleId);
    return totalRow(combineCounts(members, rules), members.length, rules);
  };
  const th = 'px-3 py-2.5 text-xs font-medium text-ink-3 whitespace-nowrap';
  const td = 'num px-3 py-3 text-right text-ink whitespace-nowrap';
  const colCount = columns.length;

  const SubtotalCells = ({ t }: { t: TotalRow }) => (
    <>
      <td className={`${td} font-semibold`}>{n(t.totalTc)}</td>
      <td className={`${td} font-semibold`}>{n(t.passed)}</td>
      <td className={`${td} font-semibold`}>{n(t.failed)}</td>
      <td className={`${td} font-semibold`}>{n(t.blocked)}</td>
      <td className={`${td} font-semibold`}>{n(t.notTested)}</td>
      <td className={`${td} font-semibold`}>{formatPercent(t.passRatio)}</td>
      <td className={`${td} font-semibold`}>{n(t.openDefects)}</td>
      <td className={`${td} font-semibold`}>{n(t.closedDefects)}</td>
      {!compact && (
        <>
          <td className={`${td} text-xs`}>{breakdown(t.severity, rules.severityCategories)}</td>
          <td className={`${td} text-xs`}>{breakdown(t.priority, rules.priorityCategories)}</td>
          <td className={td}>{dsiText(t.dsi, d)}</td>
          <td colSpan={3} />
        </>
      )}
    </>
  );

  return (
    <div>
      {!compact && (
        <div className="no-print mb-4 flex flex-wrap items-center gap-3">
          <input type="search" placeholder="Search main modules or submodules" aria-label="Search the Overall Detailed Table" value={filter} onChange={(e) => (setFilter(e.target.value), setPage(0))} className={`${inputCls} max-w-sm`} />
          <span className="text-xs text-ink-3">
            {filteredAll.length} of {rows.length} submodules
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <caption className="sr-only">Overall Detailed Table grouped by project, main module and submodule</caption>
          <thead className="border-b border-line bg-surface-2/60">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h, i) => (
                  <th key={h.id} scope="col" className={`${th} ${i === 0 ? 'text-left' : 'text-right'}`} aria-sort={h.column.getIsSorted() === 'asc' ? 'ascending' : h.column.getIsSorted() === 'desc' ? 'descending' : 'none'}>
                    {h.column.getCanSort() && !compact ? (
                      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={h.column.getToggleSortingHandler()}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <span aria-hidden className="text-[10px]">{h.column.getIsSorted() === 'asc' ? '▲' : h.column.getIsSorted() === 'desc' ? '▼' : ''}</span>
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {visible.map((row, idx) => {
              const r = row.original;
              const newGroup = idx === 0 || visible[idx - 1]!.original.mainModuleId !== r.mainModuleId;
              const lastOfGroup = idx === visible.length - 1 || visible[idx + 1]!.original.mainModuleId !== r.mainModuleId;
              return [
                newGroup && (
                  <tr key={`g-${r.mainModuleId}-${idx}`} className="bg-navy/[0.04]">
                    <th colSpan={colCount} scope="rowgroup" className="px-3 py-2 text-left text-xs font-semibold tracking-wide text-ink-2">
                      {projectName} <span aria-hidden>›</span>{' '}
                      <Link to={`/projects/${projectId}/main/${r.mainModuleId}/overall`} className="text-ink hover:text-accent hover:underline">
                        {r.mainModuleName}
                      </Link>
                    </th>
                  </tr>
                ),
                <tr key={row.id} className="border-b border-line/70 transition-colors hover:bg-surface-2/50">
                  {row.getVisibleCells().map((cell, i) =>
                    i === 0 ? (
                      <th key={cell.id} scope="row" className="px-3 py-3 pl-6 text-left font-medium whitespace-nowrap">
                        <Link to={`/projects/${projectId}/main/${r.mainModuleId}/detailed?sub=${r.moduleId}`} className="text-ink underline-offset-4 hover:text-accent hover:underline">
                          {r.moduleName}
                        </Link>
                      </th>
                    ) : (
                      <td key={cell.id} className={`${td} ${['severity', 'priority', 'source', 'lastSync', 'status'].includes(cell.column.id) ? 'text-xs text-ink-2' : ''} ${cell.column.id === 'source' ? 'max-w-[220px] truncate text-left' : ''}`}>
                        {flexRender(cell.column.columnDef.cell ?? ((c: { getValue: () => unknown }) => n(Number(c.getValue()))), cell.getContext())}
                      </td>
                    ),
                  )}
                </tr>,
                lastOfGroup && (
                  <tr key={`s-${r.mainModuleId}-${idx}`} className="border-b border-line bg-surface-2/40">
                    <th scope="row" className="px-3 py-2.5 pl-6 text-left text-xs font-semibold whitespace-nowrap text-ink-2">
                      {r.mainModuleName} total
                    </th>
                    <SubtotalCells t={groupTotal(r.mainModuleId)} />
                  </tr>
                ),
              ];
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-3 py-10 text-center text-sm text-ink-3">
                  No submodules match this search.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t-2 border-line-strong bg-surface-2/60">
            <tr>
              <th scope="row" className="px-3 py-3 text-left font-semibold whitespace-nowrap">
                Scope total <span className="ml-1 text-xs font-normal text-ink-3">({total.moduleCount} submodules)</span>
              </th>
              <SubtotalCells t={total} />
            </tr>
          </tfoot>
        </table>
      </div>
      {!compact && pageCount > 1 && (
        <nav aria-label="Table pages" className="no-print mt-3 flex items-center justify-end gap-2 text-sm">
          <button className="rounded-md px-2.5 py-1 text-ink-2 hover:bg-surface-2 disabled:opacity-40" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            Previous
          </button>
          <span className="num text-ink-3">
            {safePage + 1} / {pageCount}
          </span>
          <button className="rounded-md px-2.5 py-1 text-ink-2 hover:bg-surface-2 disabled:opacity-40" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
