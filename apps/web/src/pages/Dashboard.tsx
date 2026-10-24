import { useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { KPI_LABELS, selectScope, type ScopeView as CoreScopeView } from '@qals/core';
import { EightCharts, STATUS_COLOR } from '../charts/Charts';
import { AddSourcesDialog } from '../components/DriveDialogs';
import { ModuleTable } from '../components/ModuleTable';
import { RequireSnapshot, useProject } from '../components/ProjectLayout';
import { Breadcrumbs, Button, EmptyState, Kpi, PageTitle } from '../components/ui';
import { dateTime, download, formatPercent, n, toCsv } from '../lib/format';
import type { PublicModuleRow, PublicSnapshot, PublicTable } from '../lib/types';

type ScopeView = CoreScopeView<PublicModuleRow>;

function SnapshotMeta({ s }: { s: PublicSnapshot }) {
  return (
    <p className="num text-xs text-ink-3">
      Snapshot v{s.version} · {s.snapshot_id.slice(0, 8)} · as of {dateTime(s.source_cutoff)} · ruleset {s.ruleset_version}
    </p>
  );
}

/** The four mandatory KPI cards with their exact labels (SRS V1.5 §8). */
function KpiRow({ view, hintTotal }: { view: ScopeView; hintTotal?: string }) {
  const t = view.totals;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi label={KPI_LABELS.totalTc} value={n(t.totalTc)} hint={hintTotal ?? `${t.moduleCount} submodule${t.moduleCount === 1 ? '' : 's'}`} accent="var(--navy)" />
      <Kpi label={KPI_LABELS.passed} value={n(t.passed)} hint={`${n(t.failed)} failed · ${n(t.blocked + t.notTested)} other`} accent={STATUS_COLOR.Passed} />
      <Kpi label={KPI_LABELS.openDefects} value={n(t.openDefects)} hint={`${n(t.closedDefects)} closed`} accent="var(--lc-open)" />
      <Kpi label={KPI_LABELS.passRatio} value={formatPercent(t.passRatio)} hint="Passed ÷ Total TC" accent="var(--sky)" />
    </div>
  );
}

function exportScope(s: PublicSnapshot, table: PublicTable, view: ScopeView, scopeLabel: string) {
  const r = s.payload.rules;
  const head = ['Project', 'Main Module', 'Submodule', 'Total TC', 'Passed', 'Failed', 'Blocked', 'Not Tested', 'Test Pass Ratio', 'Open Defects', 'Closed Defects', ...r.severityCategories.map((c) => `Severity ${c}`), ...r.priorityCategories.map((c) => `Priority ${c}`), 'DSI', 'Source Document / Sheet', 'Last Sync / Snapshot', 'Validation Status'];
  const dsi = (v: (typeof view.rows)[number]['dsi']) => (v.status === 'ok' ? (v.value === null ? 'N/A' : v.value.toFixed(r.dsi?.decimals ?? 2)) : 'Unavailable');
  const rows = view.rows.map((m) => {
    const src = table.rows.find((x) => x.moduleId === m.moduleId)?.sources ?? [];
    return [s.project_name, m.mainModuleName, m.moduleName, m.totalTc, m.passed, m.failed, m.blocked, m.notTested, formatPercent(m.passRatio), m.openDefects, m.closedDefects, ...r.severityCategories.map((c) => m.severity[c] ?? 0), ...r.priorityCategories.map((c) => m.priority[c] ?? 0), dsi(m.dsi), src.map((x) => x.sheetTitle).join('; '), `${m.lastSourceUpdate ?? ''} · v${s.version}`, s.validation.runState];
  });
  const t = view.totals;
  rows.push([s.project_name, scopeLabel, 'Scope total', t.totalTc, t.passed, t.failed, t.blocked, t.notTested, formatPercent(t.passRatio), t.openDefects, t.closedDefects, ...r.severityCategories.map((c) => t.severity[c] ?? 0), ...r.priorityCategories.map((c) => t.priority[c] ?? 0), t.dsi.status === 'ok' ? (t.dsi.value === null ? 'N/A' : t.dsi.value.toFixed(r.dsi?.decimals ?? 2)) : 'Unavailable', '', `v${s.version}`, s.validation.runState]);
  const meta: [string, string][] = [
    ['Project', `${s.project_name} (${s.project_id})`],
    ['Scope', scopeLabel],
    ['Snapshot ID', s.snapshot_id],
    ['Snapshot version', String(s.version)],
    ['Source cut-off', s.source_cutoff],
    ['Ruleset', s.ruleset_version],
    ['Validation state', s.validation.runState],
  ];
  download(`${s.project_id}-${scopeLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v${s.version}.csv`, toCsv(head, rows, meta));
}

/** Project overview: all main modules of one project, charts grouped by main module. */
export function ProjectOverview() {
  const { projectId, project } = useProject();
  const nav = useNavigate();
  return (
    <RequireSnapshot>
      {(s) => {
        const view = selectScope(s.payload.table, s.payload.rules);
        if (s.payload.table.rows.length === 0) {
          return (
            <EmptyState title="No validated submodules yet" action={<Link className="text-sm font-medium text-accent hover:underline" to={`/projects/${projectId}/sources`}>Manage data sources</Link>}>
              Add Google Drive sources to a main module. Dashboards appear once data is read and all five checks pass — no zeros are shown before then.
            </EmptyState>
          );
        }
        return (
          <div className="flex flex-col gap-6">
            <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Project Hub', to: '/projects' }, { label: project.name }]} />
            <PageTitle eyebrow={`${project.name} · Project overview`} title="All main modules">
              <SnapshotMeta s={s} />
            </PageTitle>
            <KpiRow view={view} hintTotal={`${s.payload.hierarchy.length} main module${s.payload.hierarchy.length === 1 ? '' : 's'}`} />
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {s.payload.table.mainModules.map((m) => (
                <li key={m.mainModuleId}>
                  <Link to={`/projects/${projectId}/main/${m.mainModuleId}/overall`} className="group block rounded-2xl border border-line bg-surface p-5 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-sky">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-bold text-ink">{m.name}</h2>
                      <span aria-hidden className="text-sm font-semibold text-accent transition-transform group-hover:translate-x-0.5">Overall →</span>
                    </div>
                    <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                      <div><dt className="text-xs text-ink-3">Total TC</dt><dd className="num text-lg font-bold text-ink">{n(m.totalTc)}</dd></div>
                      <div><dt className="text-xs text-ink-3">Pass ratio</dt><dd className="num text-lg font-bold text-ink">{formatPercent(m.passRatio)}</dd></div>
                      <div><dt className="text-xs text-ink-3">Open defects</dt><dd className="num text-lg font-bold text-ink">{n(m.openDefects)}</dd></div>
                    </dl>
                    <p className="mt-3 text-xs text-ink-3">{m.moduleCount} submodule{m.moduleCount === 1 ? '' : 's'}</p>
                  </Link>
                </li>
              ))}
            </ul>
            <EightCharts charts={view.charts} rules={s.payload.rules} groupLabel="Main module" onGroup={(id) => nav(`/projects/${projectId}/main/${id}/overall`)} />
          </div>
        );
      }}
    </RequireSnapshot>
  );
}

const findMainModule = (s: PublicSnapshot, mainModuleId: string) => s.payload.hierarchy.find((m) => m.mainModuleId === mainModuleId) ?? null;

function MissingMainModule({ projectId }: { projectId: string }) {
  return (
    <EmptyState title="Main module not in the published snapshot" action={<Link className="text-sm font-medium text-accent hover:underline" to={`/projects/${projectId}`}>Back to project overview</Link>}>
      It may be new and awaiting validation, or archived.
    </EmptyState>
  );
}

/** Main-module Overall Dashboard: all validated submodules of this main module only (V1.5 §5.4). */
export function MainModuleOverall() {
  const { projectId, project, snapshot } = useProject();
  const { mainModuleId = '' } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const adding = loc.pathname.endsWith('/add');
  const known = snapshot ? findMainModule(snapshot, mainModuleId) : null;
  // + Add works even before the main module has a validated snapshot (new projects).
  const dialog = (
    <AddSourcesDialog
      open={adding}
      onClose={() => nav(known ? `/projects/${projectId}/main/${mainModuleId}/overall` : `/projects/${projectId}/sources`)}
      projectId={projectId}
      projectName={project.name}
      mainModuleId={mainModuleId}
      mainModuleName={known?.name ?? mainModuleId}
    />
  );
  return (
    <>
    {dialog}
    <RequireSnapshot>
      {(s) => {
        const node = findMainModule(s, mainModuleId);
        if (!node) return <MissingMainModule projectId={projectId} />;
        const view = selectScope(s.payload.table, s.payload.rules, { mainModuleId });
        return (
          <div className="flex flex-col gap-6">
            <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: project.name, to: `/projects/${projectId}` }, { label: node.name }, { label: 'Overall Dashboard' }]} />
            <PageTitle eyebrow={`${project.name} · ${node.name}`} title="Overall Dashboard">
              <Link to={`/projects/${projectId}/main/${mainModuleId}/detailed`} className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-surface-2">
                Detailed Dashboard
              </Link>
              <Link to={`/projects/${projectId}/main/${mainModuleId}/add`} className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-ink hover:bg-primary-hover">
                + Add from Google Drive
              </Link>
            </PageTitle>
            <p className="-mt-4 text-sm text-ink-3">
              All {node.submodules.length} validated submodule{node.submodules.length === 1 ? '' : 's'} of {node.name} — no other module or project. <SnapshotMeta s={s} />
            </p>
            {node.submodules.length === 0 ? (
              <EmptyState title="No validated submodules yet">Add Google Drive sources to {node.name}; valid sheet tabs become submodules after validation.</EmptyState>
            ) : (
              <>
                <KpiRow view={view} />
                <EightCharts charts={view.charts} rules={s.payload.rules} groupLabel="Submodule" onGroup={(id) => nav(`/projects/${projectId}/main/${mainModuleId}/detailed?sub=${id}`)} />
              </>
            )}
          </div>
        );
      }}
    </RequireSnapshot>
    </>
  );
}

/** Main-module Detailed Dashboard with the submodule filter (V1.5 §5.5, AT-12). */
export function MainModuleDetailed() {
  const { projectId, project, snapshot } = useProject();
  const { mainModuleId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const selected = useMemo(() => (params.get('sub') ?? '').split(',').filter(Boolean), [params]);
  const setSel = (ids: string[]) => setParams(ids.length ? { sub: ids.join(',') } : {}, { replace: true });
  return (
    <RequireSnapshot>
      {(s) => {
        const node = findMainModule(s, mainModuleId);
        if (!node) return <MissingMainModule projectId={projectId} />;
        const valid = selected.filter((id) => node.submodules.some((x) => x.id === id));
        const view = selectScope(s.payload.table, s.payload.rules, { mainModuleId, submoduleIds: valid });
        const mainTotal = selectScope(s.payload.table, s.payload.rules, { mainModuleId }).totals;
        const label = valid.length ? node.submodules.filter((x) => valid.includes(x.id)).map((x) => x.name).join(', ') : `All Submodules (${node.submodules.length})`;
        const chip = (on: boolean) => `inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors ${on ? 'border-primary bg-primary text-primary-ink' : 'border-line-strong bg-surface text-ink hover:bg-surface-2'}`;
        const scopeRows = s.payload.table.rows.filter((r) => view.rows.some((v) => v.moduleId === r.moduleId));
        return (
          <div className="flex flex-col gap-6">
            <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: project.name, to: `/projects/${projectId}` }, { label: node.name, to: `/projects/${projectId}/main/${mainModuleId}/overall` }, { label: 'Detailed Dashboard' }]} />
            <PageTitle eyebrow={`${project.name} · ${node.name}`} title="Detailed Dashboard">
              <Button onClick={() => exportScope(s, s.payload.table, view, `${node.name} — ${label}`)}>Export CSV (filtered)</Button>
            </PageTitle>
            <section aria-label="Submodule filter" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-ink">Submodule filter</h2>
                <p className="text-sm text-ink-2">
                  Showing: <strong className="text-ink">{label}</strong>
                </p>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Submodules">
                <button className={chip(valid.length === 0)} aria-pressed={valid.length === 0} onClick={() => setSel([])}>
                  All Submodules
                </button>
                {node.submodules.map((x) => {
                  const on = valid.includes(x.id);
                  return (
                    <button key={x.id} className={chip(on)} aria-pressed={on} onClick={() => setSel(on ? valid.filter((v) => v !== x.id) : [...valid, x.id])}>
                      <span aria-hidden>{on ? '✓' : '+'}</span>
                      {x.name}
                    </button>
                  );
                })}
                {valid.length > 0 && (
                  <button className="h-9 px-2 text-sm font-medium text-accent underline underline-offset-4" onClick={() => setSel([])}>
                    Reset
                  </button>
                )}
              </div>
              <p className="text-xs text-ink-3">
                {node.name} total: {n(mainTotal.totalTc)} TC · {view.filtered ? `filtered: ${n(view.totals.totalTc)} TC` : 'no filter applied'}. KPIs, all eight charts, the table and the export follow this filter.
              </p>
            </section>
            <KpiRow view={view} hintTotal={view.filtered ? `of ${n(mainTotal.totalTc)} in ${node.name}` : undefined} />
            <EightCharts charts={view.charts} rules={s.payload.rules} groupLabel="Submodule" />
            <section>
              <h2 className="mb-3 text-base font-bold text-ink">Overall Detailed Table</h2>
              <ModuleTable projectId={projectId} projectName={project.name} rows={scopeRows} total={view.totals} rules={s.payload.rules} snapshotVersion={s.version} validationState={snapshot?.validation.runState ?? 'Validated'} />
            </section>
          </div>
        );
      }}
    </RequireSnapshot>
  );
}
