import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { PRODUCT_NAME } from '../components/Brand';

/** `/` — product title and one prominent Open Dashboard button; no login form (SRS V1.5 §5.6). */
export function Home() {
  useEffect(() => {
    document.title = PRODUCT_NAME;
  }, []);
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <section className="bg-navy px-6 pt-7 pb-32 text-navy-ink">
        <div className="mx-auto flex max-w-6xl flex-col gap-16">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <span className="text-[0.95rem] font-semibold">{PRODUCT_NAME}</span>
            <span className="hidden text-xs font-semibold tracking-[0.16em] text-sky uppercase sm:inline">Multi-project QA intelligence</span>
          </header>
          <div className="flex max-w-3xl flex-col gap-6">
            <h1 className="text-[clamp(2.4rem,5.6vw,4rem)] leading-[1.04] font-extrabold tracking-[-0.025em]">{PRODUCT_NAME}</h1>
            <p className="max-w-2xl text-lg leading-relaxed text-navy-ink-2">
              Validated test case and defect intelligence for every project, synchronized from your Google Drive and OneDrive sources and published only after five automated checks pass.
            </p>
          </div>
        </div>
      </section>
      <section className="-mt-20 px-6">
        <div className="mx-auto grid max-w-6xl gap-10 rounded-3xl border border-line bg-surface p-8 shadow-[0_30px_80px_-40px_rgba(11,40,88,0.4)] sm:p-10 lg:grid-cols-[1fr_2fr] lg:items-center">
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium text-ink-2">No sign-in form. Administration is protected server-side.</span>
            <Link
              to="/projects"
              className="inline-flex h-15 items-center gap-3 self-start rounded-2xl bg-sky px-8 text-lg font-bold text-sky-ink shadow-[0_10px_30px_-12px_rgba(56,189,248,0.8)] transition-[transform,background-color] duration-150 hover:bg-sky/85 active:scale-[0.98]"
            >
              Open Dashboard
              <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 10h11M11 5.5 15.5 10 11 14.5" />
              </svg>
            </Link>
          </div>
          <dl className="grid gap-6 sm:grid-cols-3">
            {[
              ['Validated before publishing', 'Completeness, duplicates, counts, all eight charts and dataset integrity.'],
              ['Live for every colleague', 'Updates arrive without refreshing; the last verified snapshot stays visible.'],
              ['Isolated by project', 'Each project keeps its own sources, modules, snapshots and audit trail.'],
            ].map(([t, d]) => (
              <div key={t}>
                <dt className="font-bold text-ink">{t}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-ink-2">{d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
      <footer className="mx-auto mt-auto w-full max-w-6xl px-6 py-8 text-xs text-ink-3">{PRODUCT_NAME} · Aggregated QA metrics only</footer>
    </div>
  );
}
