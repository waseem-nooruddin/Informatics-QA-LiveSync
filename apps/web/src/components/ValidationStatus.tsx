import { useEffect, useRef, useState } from 'react';
import { dateTime, isStale, relative } from '../lib/format';
import { useNow, type LiveStatus } from '../lib/data';
import type { GateSummary, ProjectState, PublicSnapshot } from '../lib/types';

const TONE = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  muted: 'bg-surface-2 text-ink-2',
} as const;

function stateTone(s: string | undefined): keyof typeof TONE {
  if (s === 'Validated') return 'ok';
  if (s === 'Validation Failed' || s === 'Sync Failed') return 'bad';
  if (s === 'Validating') return 'info';
  return 'muted';
}

const GATE_ICON: Record<GateSummary['state'], string> = { Passed: '✓', Failed: '✕', Pending: '…' };

/**
 * Unobtrusive header status with expandable diagnostics (FR-DES-005, §9.1).
 * Freshness (Stale) is shown alongside the run state, never replacing it.
 */
export function ValidationStatus({ state, snapshot, live, staleMinutes }: { state: ProjectState | null | undefined; snapshot: PublicSnapshot | null | undefined; live: LiveStatus; staleMinutes: number }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, []);

  const runState = state?.run_state ?? 'Pending';
  const verifiedAt = snapshot?.published_at ?? state?.last_verified_at ?? null;
  const stale = isStale(verifiedAt, now, staleMinutes);
  const tone = stateTone(runState);
  const gates = state?.gate_progress?.length ? state.gate_progress : (snapshot?.validation.gates ?? []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface pr-3 pl-1.5 text-sm transition-colors hover:bg-surface-2"
      >
        <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold ${TONE[tone]}`}>
          <span aria-hidden className={`size-1.5 rounded-full bg-current ${runState === 'Validating' ? 'animate-pulse' : ''}`} />
          {runState}
        </span>
        {stale && <span className={`inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold ${TONE.warn}`}>Stale data</span>}
        <span className="hidden text-xs text-ink-3 md:inline">
          Verified <time dateTime={verifiedAt ?? undefined}>{relative(verifiedAt, now)}</time>
        </span>
        <svg aria-hidden viewBox="0 0 20 20" className={`size-4 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="currentColor">
          <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div role="dialog" aria-label="Validation diagnostics" className="absolute right-0 z-30 mt-2 w-[min(92vw,380px)] origin-top-right rounded-2xl border border-line bg-surface p-4 shadow-xl">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-ink-3">Snapshot</dt>
            <dd className="num truncate text-ink">{snapshot ? `v${snapshot.version} · ${snapshot.snapshot_id.slice(0, 8)}` : 'None published yet'}</dd>
            <dt className="text-ink-3">Last verified</dt>
            <dd className="text-ink">{dateTime(verifiedAt)}</dd>
            <dt className="text-ink-3">Last attempt</dt>
            <dd className="text-ink">{dateTime(state?.last_attempt_at)}</dd>
            {state?.last_failure_at && (
              <>
                <dt className="text-ink-3">Last failure</dt>
                <dd className="text-bad">{dateTime(state.last_failure_at)}</dd>
              </>
            )}
            <dt className="text-ink-3">Sources</dt>
            <dd className="text-ink">
              {state?.source_health?.total ? `${state.source_health.healthy}/${state.source_health.total} healthy` : '—'}
            </dd>
            <dt className="text-ink-3">Updates</dt>
            <dd className="text-ink">{live === 'live' ? 'Live' : live === 'polling' ? 'Polling every 30 s' : 'Connecting…'}</dd>
          </dl>
          {state?.last_error && <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{state.last_error}</p>}
          <h4 className="mt-4 mb-2 text-xs font-semibold tracking-wide text-ink-3 uppercase">Validation gates</h4>
          {gates.length === 0 ? (
            <p className="text-xs text-ink-3">No validation has run yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {gates.map((g) => (
                <li key={g.id} className="flex items-center gap-2.5 text-xs">
                  <span
                    aria-hidden
                    className={`grid size-5 place-items-center rounded-full text-[10px] font-bold ${g.state === 'Passed' ? TONE.ok : g.state === 'Failed' ? TONE.bad : TONE.muted}`}
                  >
                    {GATE_ICON[g.state]}
                  </span>
                  <span className="num w-[5.5rem] shrink-0 text-ink-3">{g.id}</span>
                  <span className="flex-1 text-ink">
                    {g.name}
                    {!g.blocking && <span className="text-ink-3"> · non-blocking</span>}
                  </span>
                  <span className="sr-only">{g.state}</span>
                  <span className={g.state === 'Failed' ? 'font-medium text-bad' : 'text-ink-3'}>{g.state === 'Passed' ? 'Passed' : g.discrepancyCount ? `${g.discrepancyCount} issue${g.discrepancyCount > 1 ? 's' : ''}` : g.state}</span>
                </li>
              ))}
            </ul>
          )}
          {snapshot?.ruleset_provisional && (
            <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-3">
              Ruleset <span className="num">{snapshot.ruleset_version}</span> is provisional: the pass-ratio denominator and defect mappings are pending QA-owner sign-off.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
