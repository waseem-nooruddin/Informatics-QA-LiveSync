import { CHART_TITLES, selectScope, TEST_STATUSES, type ChartData } from '@qals/core';
import { RequireSnapshot, useProject } from '../components/ProjectLayout';
import { Breadcrumbs, Button, Card, PageTitle } from '../components/ui';
import { dateTime, download, formatPercent, toCsv } from '../lib/format';
import type { PublicSnapshot } from '../lib/types';

/** Every export carries project, scope, snapshot id, as-of time, ruleset and validation state. */
function meta(s: PublicSnapshot, scope: string): [string, string][] {
  return [
    ['Product', 'QA LiveSync'],
    ['Project', `${s.project_name} (${s.project_id})`],
    ['Scope', scope],
    ['Snapshot ID', s.snapshot_id],
    ['Snapshot version', String(s.version)],
    ['Published at', s.published_at],
    ['Source cut-off', s.source_cutoff],
    ['Ruleset', s.ruleset_version],
    ['Mapping version', s.mapping_version],
    ['Validation state', s.validation.runState],
  ];
}

function exportTable(s: PublicSnapshot) {
  const r = s.payload.rules;
  const d = r.dsi?.decimals ?? 2;
  const dsi = (v: { status: string; value?: number | null }) => (v.status === 'ok' ? (v.value == null ? 'N/A' : v.value.toFixed(d)) : 'Unavailable');
  const head = ['Project', 'Main Module', 'Submodule', 'Total TC', 'Passed', 'Failed', 'Blocked', 'Not Tested', 'Test Pass Ratio', 'Open Defects', 'Closed Defects', ...r.severityCategories.map((c) => `Severity ${c}`), ...r.priorityCategories.map((c) => `Priority ${c}`), 'DSI', 'Source Document / Sheet', 'Last Sync / Snapshot', 'Validation Status'];
  const rows: (string | number)[][] = [];
  for (const mm of s.payload.table.mainModules) {
    for (const m of s.payload.table.rows.filter((x) => x.mainModuleId === mm.mainModuleId)) {
      rows.push([s.project_name, mm.name, m.moduleName, m.totalTc, m.passed, m.failed, m.blocked, m.notTested, formatPercent(m.passRatio), m.openDefects, m.closedDefects, ...r.severityCategories.map((c) => m.severity[c] ?? 0), ...r.priorityCategories.map((c) => m.priority[c] ?? 0), dsi(m.dsi), m.sources.map((x) => x.sheetTitle).join('; '), `${m.lastSourceUpdate ?? ''} · v${s.version}`, s.validation.runState]);
    }
    rows.push([s.project_name, mm.name, `${mm.name} total`, mm.totalTc, mm.passed, mm.failed, mm.blocked, mm.notTested, formatPercent(mm.passRatio), mm.openDefects, mm.closedDefects, ...r.severityCategories.map((c) => mm.severity[c] ?? 0), ...r.priorityCategories.map((c) => mm.priority[c] ?? 0), dsi(mm.dsi), '', `v${s.version}`, s.validation.runState]);
  }
  const o = s.payload.table.overall;
  rows.push([s.project_name, 'All main modules', 'Project total', o.totalTc, o.passed, o.failed, o.blocked, o.notTested, formatPercent(o.passRatio), o.openDefects, o.closedDefects, ...r.severityCategories.map((c) => o.severity[c] ?? 0), ...r.priorityCategories.map((c) => o.priority[c] ?? 0), dsi(o.dsi), '', `v${s.version}`, s.validation.runState]);
  download(`${s.project_id}-overall-detailed-table-v${s.version}.csv`, toCsv(head, rows, meta(s, 'Whole project')));
}

function chartRows(scope: string, c: ChartData, d: number): (string | number)[][] {
  return [
    ...c.moduleRegistration.map((x) => [scope, CHART_TITLES.moduleRegistration, x.name, 'Total TC', x.totalTc]),
    [scope, CHART_TITLES.moduleByOverall, 'All', 'Test Pass', c.moduleByOverall.pass],
    [scope, CHART_TITLES.moduleByOverall, 'All', 'Test Failed', c.moduleByOverall.failed],
    [scope, CHART_TITLES.moduleByOverall, 'All', 'Other (Blocked + Not Tested)', c.moduleByOverall.other],
    ...c.testStatusByModule.flatMap((x) => TEST_STATUSES.map((st) => [scope, CHART_TITLES.testStatusByModule, x.name, st, x[st]])),
    [scope, CHART_TITLES.openVsClosed, 'All', 'Open', c.openVsClosed.Open],
    [scope, CHART_TITLES.openVsClosed, 'All', 'Closed', c.openVsClosed.Closed],
    ...c.openVsClosedByModule.flatMap((x) => [[scope, CHART_TITLES.openVsClosedByModule, x.name, 'Open', x.Open], [scope, CHART_TITLES.openVsClosedByModule, x.name, 'Closed', x.Closed]]),
    ...c.severityByModule.flatMap((x) => Object.entries(x.counts).map(([k, v]) => [scope, CHART_TITLES.severityByModule, x.name, k, v])),
    ...c.priorityByModule.flatMap((x) => Object.entries(x.counts).map(([k, v]) => [scope, CHART_TITLES.priorityByModule, x.name, k, v])),
    ...c.dsiByModule.map((x) => [scope, CHART_TITLES.dsiByModule, x.name, 'DSI', x.dsi.status === 'ok' ? (x.dsi.value === null ? 'N/A' : x.dsi.value.toFixed(d)) : 'Unavailable']),
  ];
}

function exportCharts(s: PublicSnapshot) {
  const d = s.payload.rules.dsi?.decimals ?? 2;
  const rows = [...chartRows('Project', selectScope(s.payload.table, s.payload.rules).charts, d)];
  for (const mm of s.payload.hierarchy) rows.push(...chartRows(mm.name, selectScope(s.payload.table, s.payload.rules, { mainModuleId: mm.mainModuleId }).charts, d));
  download(`${s.project_id}-charts-v${s.version}.csv`, toCsv(['Scope', 'Chart', 'Group', 'Category', 'Value'], rows, meta(s, 'Project and every main module')));
}

export function Reports() {
  const { projectId, project } = useProject();
  return (
    <RequireSnapshot>
      {(s) => (
        <div className="flex flex-col gap-6">
          <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Reports & exports' }]} />
          <PageTitle eyebrow={`${project.name} · Reports`} title="Reports & exports" />
          <Card className="p-6">
            <h2 className="text-base font-semibold text-ink">Snapshot included in every export</h2>
            <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {meta(s, 'Whole project').map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-line/70 py-1.5">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="num text-right text-ink">{k === 'Published at' || k === 'Source cut-off' ? dateTime(v) : v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <div className="grid gap-4 md:grid-cols-3">
            <ExportCard title="Overall Detailed Table" body="Grouped by main module and submodule, with main-module and project totals, as CSV." action={<Button variant="primary" onClick={() => exportTable(s)}>Download CSV</Button>} />
            <ExportCard title="Chart data" body="The data behind all eight charts, for the project and each main module, as CSV." action={<Button onClick={() => exportCharts(s)}>Download CSV</Button>} />
            <ExportCard title="Printable report" body="Open any dashboard and save it as PDF. Navigation and controls are hidden in print." action={<Button onClick={() => window.print()}>Print / PDF</Button>} />
          </div>
          <p className="text-xs text-ink-3">Filtered exports: use “Export CSV (filtered)” on a main module’s Detailed Dashboard.</p>
        </div>
      )}
    </RequireSnapshot>
  );
}

function ExportCard({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <Card className="flex flex-col p-5">
      <h3 className="text-[0.95rem] font-semibold text-ink">{title}</h3>
      <p className="mt-1 mb-5 text-sm text-ink-2">{body}</p>
      <div className="mt-auto">{action}</div>
    </Card>
  );
}
