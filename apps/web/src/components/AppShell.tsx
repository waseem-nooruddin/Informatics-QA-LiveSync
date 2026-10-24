import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { useDirectory, useNavHierarchy, type NavMainModule } from '../lib/data';
import { BrandLink } from './Brand';

const NAV_KEY = 'qals.nav.expanded';

function loadExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(NAV_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={`size-3.5 shrink-0 text-sky transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>
      <path d="M7.5 5 12.5 10l-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Collapsed branches leave the tab order and the accessibility tree. */
const closedProps = (open: boolean) => (open ? {} : ({ inert: '', 'aria-hidden': true } as Record<string, unknown>));

const leaf = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.82rem] transition-colors ${isActive ? 'bg-sky font-semibold text-sky-ink' : 'text-navy-ink-2 hover:bg-white/[0.06] hover:text-navy-ink'}`;

/**
 * Mandatory dynamic navigation (SRS V1.5 §5.1):
 * Home → Project → Main Module → Submodules · Overall Dashboard · Detailed Dashboard · + Add.
 * Everything below a project comes from the validated published hierarchy only.
 */
function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { projectId, mainModuleId } = useParams();
  const dir = useDirectory();
  const nav = useNavHierarchy();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(loadExpanded);
  const [q, setQ] = useState('');

  useEffect(() => {
    setExpanded((e) => ({ ...e, ...(projectId ? { [projectId]: true } : {}), ...(projectId && mainModuleId ? { [`${projectId}/${mainModuleId}`]: true } : {}) }));
  }, [projectId, mainModuleId]);
  useEffect(() => {
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify(expanded));
    } catch {
      /* storage unavailable: expansion is per-session only */
    }
  }, [expanded]);

  const term = q.trim().toLowerCase();
  const projects = useMemo(() => {
    const list = (dir.data ?? []).filter((p) => !p.archived_at || p.project_id === projectId);
    if (!term) return list;
    return list.filter((p) => {
      if (p.name.toLowerCase().includes(term)) return true;
      return (nav.data?.get(p.project_id) ?? []).some((m) => m.name.toLowerCase().includes(term) || m.submodules.some((s) => s.name.toLowerCase().includes(term)));
    });
  }, [dir.data, nav.data, term, projectId]);

  const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !e[k] }));
  const isOpen = (k: string) => !!term || !!expanded[k];

  const mainModuleBranch = (pid: string, m: NavMainModule) => {
    const key = `${pid}/${m.id}`;
    const open = isOpen(key);
    const subs = term ? m.submodules.filter((s) => s.name.toLowerCase().includes(term) || m.name.toLowerCase().includes(term)) : m.submodules;
    return (
      <li key={m.id}>
        <div className="flex items-center gap-1">
          <button aria-expanded={open} aria-controls={`nav-${key}`} onClick={() => toggle(key)} className="flex min-h-9 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[0.84rem] font-semibold text-navy-ink hover:bg-white/[0.06]">
            <Chevron open={open} />
            <span className="truncate">{m.name}</span>
          </button>
          <Link
            to={`/projects/${pid}/main/${m.id}/add`}
            aria-label={`Add Google Drive sources to ${m.name}`}
            title={`Add from Google Drive to ${m.name}`}
            className="grid size-8 shrink-0 place-items-center rounded-md border border-sky/50 text-base font-bold text-sky hover:bg-sky hover:text-sky-ink"
          >
            +
          </Link>
        </div>
        <div id={`nav-${key}`} className="nav-collapse" data-open={open}>
          <div {...closedProps(open)}>
            <div className="mt-0.5 mb-2 ml-[0.85rem] flex flex-col gap-0.5 border-l border-white/10 pl-2.5">
              <span className="px-2 pt-1 text-[0.64rem] font-bold tracking-[0.14em] text-sky/90 uppercase">Submodules</span>
              {subs.length === 0 ? (
                <span className="px-2 py-1 text-xs text-navy-ink-2/80">None validated yet</span>
              ) : (
                subs.map((s) => (
                  <Link key={s.id} to={`/projects/${pid}/main/${m.id}/detailed?sub=${s.id}`} className="rounded-md px-2 py-1.5 text-[0.82rem] text-navy-ink-2 hover:bg-white/[0.06] hover:text-navy-ink">
                    {s.name}
                  </Link>
                ))
              )}
              <span className="px-2 pt-2 text-[0.64rem] font-bold tracking-[0.14em] text-sky/90 uppercase">Dashboards</span>
              <NavLink to={`/projects/${pid}/main/${m.id}/overall`} className={leaf}>
                Overall Dashboard
              </NavLink>
              <NavLink to={`/projects/${pid}/main/${m.id}/detailed`} className={leaf}>
                Detailed Dashboard
              </NavLink>
            </div>
          </div>
        </div>
      </li>
    );
  };

  return (
    <nav aria-label="Projects and modules" className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-5" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="px-1">
        <BrandLink />
      </div>
      <label className="px-1">
        <span className="sr-only">Search projects and modules</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search modules…"
          className="h-9 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 text-sm text-navy-ink placeholder:text-navy-ink-2/70 focus:border-sky focus:outline-none"
        />
      </label>
      <div className="flex flex-col gap-0.5">
        <NavLink to="/" end className={leaf}>
          Home
        </NavLink>
        <NavLink to="/projects" end className={leaf}>
          Project Hub
        </NavLink>
      </div>
      <div>
        <div className="mb-2 px-2 text-[0.66rem] font-bold tracking-[0.16em] text-sky uppercase">Projects</div>
        {dir.isLoading && <div className="px-2 text-xs text-navy-ink-2">Loading…</div>}
        {!dir.isLoading && projects.length === 0 && <div className="px-2 text-xs text-navy-ink-2">{term ? 'No matches' : 'No projects yet'}</div>}
        <ul className="flex flex-col gap-0.5">
          {projects.map((p) => {
            const open = isOpen(p.project_id);
            const mains = nav.data?.get(p.project_id) ?? [];
            const shown = term ? mains.filter((m) => m.name.toLowerCase().includes(term) || m.submodules.some((s) => s.name.toLowerCase().includes(term)) || p.name.toLowerCase().includes(term)) : mains;
            return (
              <li key={p.project_id}>
                <div className="flex items-center">
                  <button aria-expanded={open} aria-controls={`nav-${p.project_id}`} onClick={() => toggle(p.project_id)} className="flex min-h-9 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-[0.9rem] font-bold text-navy-ink hover:bg-white/[0.06]">
                    <Chevron open={open} />
                    <span className="truncate">{p.name}</span>
                    {p.archived_at && <span className="text-[0.7rem] font-normal text-navy-ink-2">(archived)</span>}
                  </button>
                </div>
                <div id={`nav-${p.project_id}`} className="nav-collapse" data-open={open}>
                  <div {...closedProps(open)}>
                    <ul className="mt-0.5 mb-2 ml-[0.85rem] flex flex-col gap-0.5 border-l border-white/10 pl-2">
                      <li>
                        <NavLink to={`/projects/${p.project_id}`} end className={leaf}>
                          Project overview
                        </NavLink>
                      </li>
                      {shown.length === 0 ? (
                        <li className="px-2 py-1 text-xs text-navy-ink-2/80">No validated main modules yet</li>
                      ) : (
                        shown.map((m) => mainModuleBranch(p.project_id, m))
                      )}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-auto flex flex-col gap-3">
        {projectId && (
          <div className="flex flex-col gap-0.5 border-t border-white/10 pt-3">
            <span className="px-2 pb-1 text-[0.64rem] font-bold tracking-[0.14em] text-sky/90 uppercase">Project tools</span>
            <NavLink to={`/projects/${projectId}/sources`} className={leaf}>
              Data sources &amp; review
            </NavLink>
            <NavLink to={`/projects/${projectId}/reports`} className={leaf}>
              Reports &amp; exports
            </NavLink>
            <NavLink to={`/projects/${projectId}/settings`} className={leaf}>
              Project settings
            </NavLink>
          </div>
        )}
        <Link to="/projects?new=1" className="flex h-10 items-center justify-center gap-2 rounded-lg bg-sky text-sm font-bold text-sky-ink transition-colors hover:bg-sky/85">
          <span aria-hidden className="text-base leading-none">+</span> Add New Project
        </Link>
      </div>
    </nav>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[288px_1fr]">
      <aside className="sticky top-0 hidden h-dvh bg-navy lg:block">
        <Sidebar />
      </aside>
      <div className="flex items-center justify-between bg-navy px-4 py-2.5 lg:hidden">
        <BrandLink />
        <button onClick={() => setMobileOpen(true)} className="h-11 rounded-lg px-3.5 text-sm font-semibold text-navy-ink ring-1 ring-white/25" aria-label="Open navigation" aria-expanded={mobileOpen}>
          Menu
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-navy/50" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[min(86vw,320px)] bg-navy shadow-2xl">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <main className="min-w-0 px-4 py-6 sm:px-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-[1360px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
