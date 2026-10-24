import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_TITLES, statusPercentages, TEST_STATUSES, type ChartData, type CountMap, type DsiValue } from '@qals/core';
import { ChartCard, Segmented } from '../components/ui';
import { formatPercent, n } from '../lib/format';
import type { PublicRules } from '../lib/types';

// Every chart consumes one ChartData object derived from the validated snapshot (SRS V1.5 §9).

export const STATUS_COLOR: Record<string, string> = {
  Passed: 'var(--st-passed)',
  Failed: 'var(--st-failed)',
  Blocked: 'var(--st-blocked)',
  'Not Tested': 'var(--st-nottested)',
};
const LC_COLOR = { Open: 'var(--lc-open)', Closed: 'var(--lc-closed)' };
const CAT = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'].map((v) => `var(${v})`);

const axis = { stroke: 'var(--line-strong)', tick: { fill: 'var(--ink-3)', fontSize: 12 }, tickLine: false };
const vgrid = <CartesianGrid stroke="var(--line)" horizontal={false} />;
const pct = (part: number, total: number) => (total === 0 ? 'N/A' : formatPercent((part / total) * 100));
const height = (rows: number) => Math.max(180, rows * 44 + 60);

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="min-w-[180px] rounded-xl border border-line bg-surface px-3 py-2.5 text-xs shadow-lg">
      <div className="mb-1.5 font-semibold text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-0.5">
          {r.color && <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: r.color }} />}
          <span className="flex-1 text-ink-2">{r.label}</span>
          <span className="num font-medium text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const legendFmt = (v: string) => <span className="text-xs text-ink-2">{v}</span>;

function NoData({ label = 'No data in this scope' }: { label?: string }) {
  return <div className="grid min-h-[160px] place-items-center rounded-xl bg-surface-2/60 text-sm text-ink-3">{label}</div>;
}

function Donut({ slices, centre, centreLabel }: { slices: { name: string; value: number; color: string }[]; centre: string; centreLabel: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,200px)_1fr]">
      <div className="relative mx-auto aspect-square w-full max-w-[200px]">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={slices.filter((s) => s.value).length > 1 ? 1.2 : 0} stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
            <Tooltip content={({ active, payload }) => (active && payload?.[0] ? <TooltipBox title={String(payload[0].name)} rows={[{ label: 'Test cases', value: n(Number(payload[0].value)) }, { label: 'Share', value: pct(Number(payload[0].value), total) }]} /> : null)} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="num text-2xl font-bold text-ink">{centre}</div>
            <div className="text-[11px] text-ink-3">{centreLabel}</div>
          </div>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center gap-2.5">
            <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="flex-1 truncate text-ink-2">{s.name}</span>
            <span className="num text-ink">{n(s.value)}</span>
            <span className="num w-14 text-right text-xs text-ink-3">{pct(s.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 1 · Module Registration by Total Number of TC
export function ModuleRegistrationChart({ data, groupLabel }: { data: ChartData['moduleRegistration']; groupLabel: string }) {
  const total = data.reduce((a, r) => a + r.totalTc, 0);
  const sorted = [...data].sort((a, b) => b.totalTc - a.totalTc);
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7);
  const slices = [
    ...top.map((r, i) => ({ name: r.name, value: r.totalTc, color: CAT[i]! })),
    ...(rest.length ? [{ name: `Other (${rest.length})`, value: rest.reduce((a, r) => a + r.totalTc, 0), color: 'var(--cat-other)' }] : []),
  ];
  return (
    <ChartCard title={`1 · ${CHART_TITLES.moduleRegistration}`} subtitle={`${n(total)} test cases by ${groupLabel}`} table={{ head: [groupLabel, 'Total TC', 'Share'], rows: data.map((r) => [r.name, n(r.totalTc), pct(r.totalTc, total)]) }}>
      {total === 0 ? <NoData /> : <Donut slices={slices} centre={n(total)} centreLabel="total TC" />}
    </ChartCard>
  );
}

// 2 · Module by OverAll
export function ModuleByOverallChart({ data }: { data: ChartData['moduleByOverall'] }) {
  const slices = [
    { name: 'Test Pass', value: data.pass, color: 'var(--st-passed)' },
    { name: 'Test Failed', value: data.failed, color: 'var(--st-failed)' },
    { name: 'Other (Blocked + Not Tested)', value: data.other, color: 'var(--other)' },
  ];
  return (
    <ChartCard title={`2 · ${CHART_TITLES.moduleByOverall}`} subtitle="Share of Total TC · Other = Blocked + Not Tested" table={{ head: ['Category', 'Test cases', 'Share'], rows: slices.map((s) => [s.name, n(s.value), pct(s.value, data.total)]) }}>
      {data.total === 0 ? <NoData /> : <Donut slices={slices} centre={pct(data.pass, data.total)} centreLabel="passed" />}
    </ChartCard>
  );
}

// 3 · Test Status by Module — percentages of each group's TC, rows sum to 100%
export function TestStatusByModuleChart({ data, groupLabel, onGroup }: { data: ChartData['testStatusByModule']; groupLabel: string; onGroup?: (id: string) => void }) {
  const [mode, setMode] = useState<'percent' | 'count'>('percent');
  const rows = data.map((r) => {
    const total = r.Passed + r.Failed + r.Blocked + r['Not Tested'];
    const p = statusPercentages({ passed: r.Passed, failed: r.Failed, blocked: r.Blocked, notTested: r['Not Tested'], totalTc: total });
    return mode === 'count' || !p ? { ...r, _t: total, _raw: r } : { ...r, ...p, _t: total, _raw: r };
  });
  return (
    <ChartCard
      title={`3 · ${CHART_TITLES.testStatusByModule}`}
      subtitle="Share of each group's test cases · each bar = 100%"
      controls={<Segmented label="Value mode" value={mode} onChange={setMode} options={[{ value: 'percent', label: '%' }, { value: 'count', label: 'Count' }]} />}
      table={{ head: [groupLabel, ...TEST_STATUSES, 'Total'], rows: data.map((r) => { const t = r.Passed + r.Failed + r.Blocked + r['Not Tested']; return [r.name, ...TEST_STATUSES.map((s) => `${n(r[s])} (${pct(r[s], t)})`), n(t)]; }) }}
    >
      {data.length === 0 ? (
        <NoData />
      ) : (
        <ResponsiveContainer width="100%" height={height(rows.length)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="28%">
            {vgrid}
            <XAxis type="number" {...axis} domain={mode === 'percent' ? [0, 100] : [0, 'auto']} tickFormatter={(v) => (mode === 'percent' ? `${v}%` : n(v))} allowDecimals={false} />
            <YAxis type="category" dataKey="name" {...axis} width={128} axisLine={false} />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null;
                const r = payload[0].payload as (typeof rows)[number];
                return <TooltipBox title={r.name} rows={TEST_STATUSES.map((s) => ({ label: s, value: `${n(r._raw[s])} · ${pct(r._raw[s], r._t)}`, color: STATUS_COLOR[s] }))} />;
              }}
            />
            <Legend iconType="square" iconSize={10} formatter={legendFmt} wrapperStyle={{ paddingTop: 8 }} />
            {TEST_STATUSES.map((s, i) => (
              <Bar key={s} dataKey={s} stackId="s" fill={STATUS_COLOR[s]} stroke="var(--surface)" strokeWidth={1} radius={i === TEST_STATUSES.length - 1 ? [0, 4, 4, 0] : 0} isAnimationActive={false} onClick={(d) => onGroup?.((d as unknown as { id: string }).id)} className={onGroup ? 'cursor-pointer' : ''} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// 4 · Total Open Defects vs. Closed Defects
export function OpenClosedChart({ data }: { data: ChartData['openVsClosed'] }) {
  const total = data.Open + data.Closed;
  const rows = [
    { name: 'Open' as const, value: data.Open },
    { name: 'Closed' as const, value: data.Closed },
  ];
  return (
    <ChartCard title={`4 · ${CHART_TITLES.openVsClosed}`} subtitle={`${n(total)} unique defects`} table={{ head: ['Lifecycle', 'Defects', 'Share'], rows: rows.map((r) => [r.name, n(r.value), pct(r.value, total)]) }}>
      {total === 0 ? (
        <NoData label="No defects in this scope" />
      ) : (
        <div className="flex flex-col gap-4 pt-1">
          {rows.map((r) => (
            <div key={r.name}>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: LC_COLOR[r.name] }} />
                  {r.name}
                </span>
                <span>
                  <span className="num text-lg font-semibold text-ink">{n(r.value)}</span>
                  <span className="num ml-2 text-xs text-ink-3">{pct(r.value, total)}</span>
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full" style={{ width: `${(r.value / total) * 100}%`, background: LC_COLOR[r.name] }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}

// 5 · Total Open Defects vs. Closed Defects by Module
export function OpenClosedByModuleChart({ data, groupLabel }: { data: ChartData['openVsClosedByModule']; groupLabel: string }) {
  const total = data.reduce((a, r) => a + r.Open + r.Closed, 0);
  return (
    <ChartCard title={`5 · ${CHART_TITLES.openVsClosedByModule}`} table={{ head: [groupLabel, 'Open', 'Closed', 'Total'], rows: data.map((r) => [r.name, n(r.Open), n(r.Closed), n(r.Open + r.Closed)]) }}>
      {total === 0 ? (
        <NoData label="No defects in this scope" />
      ) : (
        <ResponsiveContainer width="100%" height={height(data.length)}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="24%" barGap={2}>
            {vgrid}
            <XAxis type="number" {...axis} allowDecimals={false} />
            <YAxis type="category" dataKey="name" {...axis} width={128} axisLine={false} />
            <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => (active && payload?.[0] ? <TooltipBox title={(payload[0].payload as { name: string }).name} rows={(['Open', 'Closed'] as const).map((k) => ({ label: k, value: n((payload[0]!.payload as Record<string, number>)[k]!), color: LC_COLOR[k] }))} /> : null)} />
            <Legend iconType="square" iconSize={10} formatter={legendFmt} wrapperStyle={{ paddingTop: 8 }} />
            <Bar dataKey="Open" fill={LC_COLOR.Open} radius={[0, 4, 4, 0]} isAnimationActive={false} />
            <Bar dataKey="Closed" fill={LC_COLOR.Closed} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

// 6 · Defect Severity By Module / 7 · Defect Priority by Module (ordinal ramps, dark = more severe)
export function CategoryByModuleChart({ kind, data, categories, population, groupLabel }: { kind: 'severity' | 'priority'; data: { id: string; name: string; counts: CountMap }[]; categories: string[]; population: string; groupLabel: string }) {
  const present = new Set(data.flatMap((r) => Object.keys(r.counts).filter((k) => (r.counts[k] ?? 0) > 0)));
  const cats = [...categories, ...(present.has('Unspecified') ? ['Unspecified'] : [])];
  const color = (c: string) => {
    if (c === 'Unspecified') return 'var(--unspecified)';
    const idx = categories.indexOf(c);
    const step = Math.max(1, Math.min(4, categories.length - idx));
    return `var(--${kind === 'severity' ? 'sev' : 'pri'}-${step})`;
  };
  const rows = data.map((r) => ({ id: r.id, name: r.name, ...Object.fromEntries(cats.map((c) => [c, r.counts[c] ?? 0])) }));
  const total = data.reduce((a, r) => a + Object.values(r.counts).reduce((x, y) => x + y, 0), 0);
  const title = kind === 'severity' ? `6 · ${CHART_TITLES.severityByModule}` : `7 · ${CHART_TITLES.priorityByModule}`;
  return (
    <ChartCard title={title} subtitle={`Population: ${population === 'all' ? 'all defects (open + closed)' : 'open defects'}`} table={{ head: [groupLabel, ...cats], rows: data.map((r) => [r.name, ...cats.map((c) => n(r.counts[c] ?? 0))]) }}>
      {total === 0 ? (
        <NoData label="No defects in the approved population" />
      ) : (
        <ResponsiveContainer width="100%" height={height(rows.length)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="28%">
            {vgrid}
            <XAxis type="number" {...axis} allowDecimals={false} />
            <YAxis type="category" dataKey="name" {...axis} width={128} axisLine={false} />
            <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => (active && payload?.[0] ? <TooltipBox title={(payload[0].payload as { name: string }).name} rows={cats.map((c) => ({ label: c, value: n((payload[0]!.payload as Record<string, number>)[c] ?? 0), color: color(c) }))} /> : null)} />
            <Legend iconType="square" iconSize={10} formatter={legendFmt} wrapperStyle={{ paddingTop: 8 }} />
            {cats.map((c, i) => (
              <Bar key={c} dataKey={c} stackId="c" fill={color(c)} stroke="var(--surface)" strokeWidth={1} radius={i === cats.length - 1 ? [0, 4, 4, 0] : 0} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

const dsiText = (v: DsiValue, decimals: number) => (v.status === 'unavailable' ? 'Unavailable' : v.value === null ? 'N/A' : v.value.toFixed(decimals));

// 8 · DSI by Module (approved: Σ severity weights of open defects ÷ number of open defects)
export function DsiChart({ data, rules, groupLabel }: { data: ChartData['dsiByModule']; rules: PublicRules; groupLabel: string }) {
  const decimals = rules.dsi?.decimals ?? 2;
  const unavailable = !rules.dsi || data.some((r) => r.dsi.status === 'unavailable');
  const rows = data.map((r) => ({ name: r.name, value: r.dsi.status === 'ok' && r.dsi.value !== null ? r.dsi.value : null }));
  const weights = rules.dsi ? Object.entries(rules.dsi.weights).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
  return (
    <ChartCard title={`8 · ${CHART_TITLES.dsiByModule}`} subtitle={rules.dsi ? `Open defects · weights ${weights} · ${rules.dsi.version}` : 'Formula pending approval'} table={{ head: [groupLabel, 'DSI'], rows: data.map((r) => [r.name, dsiText(r.dsi, decimals)]) }}>
      {unavailable ? (
        <div className="flex min-h-[160px] flex-col items-center justify-center rounded-xl bg-surface-2/60 px-6 text-center">
          <span className="mb-2 inline-flex h-6 items-center rounded-full bg-warn-soft px-2.5 text-xs font-semibold text-warn">Unavailable</span>
          <p className="max-w-sm text-sm text-ink-2">{data.find((r) => r.dsi.status === 'unavailable')?.dsi.status === 'unavailable' ? (data.find((r) => r.dsi.status === 'unavailable')!.dsi as { reason: string }).reason : 'DSI formula not approved'}</p>
        </div>
      ) : rows.every((r) => r.value === null) ? (
        <NoData label="N/A — no open defects in this scope" />
      ) : (
        <ResponsiveContainer width="100%" height={height(rows.length)}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }} barCategoryGap="32%">
            {vgrid}
            <XAxis type="number" {...axis} domain={[0, Math.max(0, ...Object.values(rules.dsi?.weights ?? { x: 10 }))]} />
            <YAxis type="category" dataKey="name" {...axis} width={128} axisLine={false} />
            <Tooltip cursor={{ fill: 'var(--surface-2)' }} content={({ active, payload }) => (active && payload?.[0] ? <TooltipBox title={(payload[0].payload as { name: string }).name} rows={[{ label: 'DSI', value: payload[0].value == null ? 'N/A' : Number(payload[0].value).toFixed(decimals), color: 'var(--cat-7)' }]} /> : null)} />
            <Bar dataKey="value" fill="var(--cat-7)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

/** All eight mandatory charts for one scope, in the approved order. */
export function EightCharts({ charts, rules, groupLabel, onGroup }: { charts: ChartData; rules: PublicRules; groupLabel: string; onGroup?: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <ModuleRegistrationChart data={charts.moduleRegistration} groupLabel={groupLabel} />
        <ModuleByOverallChart data={charts.moduleByOverall} />
      </div>
      <TestStatusByModuleChart data={charts.testStatusByModule} groupLabel={groupLabel} onGroup={onGroup} />
      <div className="grid gap-6 xl:grid-cols-2">
        <OpenClosedChart data={charts.openVsClosed} />
        <OpenClosedByModuleChart data={charts.openVsClosedByModule} groupLabel={groupLabel} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <CategoryByModuleChart kind="severity" data={charts.severityByModule} categories={rules.severityCategories} population={rules.defectPopulation.severity} groupLabel={groupLabel} />
        <CategoryByModuleChart kind="priority" data={charts.priorityByModule} categories={rules.priorityCategories} population={rules.defectPopulation.priority} groupLabel={groupLabel} />
      </div>
      <DsiChart data={charts.dsiByModule} rules={rules} groupLabel={groupLabel} />
    </div>
  );
}
