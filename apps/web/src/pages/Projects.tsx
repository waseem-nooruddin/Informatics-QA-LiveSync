import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AddProjectDialog } from '../components/DriveDialogs';
import { Breadcrumbs, Button, Card, EmptyState, Notice, PageTitle, Skeleton } from '../components/ui';
import { useDirectory, useNow } from '../lib/data';
import { isStale, relative } from '../lib/format';
import { configured } from '../lib/supabase';

const STATE_TONE: Record<string, string> = {
  Validated: 'bg-ok-soft text-ok',
  'Validation Failed': 'bg-bad-soft text-bad',
  'Sync Failed': 'bg-bad-soft text-bad',
  Validating: 'bg-info-soft text-info',
  Pending: 'bg-surface-2 text-ink-2',
};

/** Project hub & platform directory (MP-FR-006, MP-FR-032). Never sums across projects. */
export function Projects() {
  const dir = useDirectory();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const adding = params.get('new') === '1';
  const [showArchived, setShowArchived] = useState(false);
  const rows = (dir.data ?? []).filter((p) => showArchived || !p.archived_at);

  return (
    <div>
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Project Hub' }]} />
      <div className="h-6" />
      {params.get('oauth') === 'connected' && <Notice tone="info" title="Google account connected">You can now choose a Drive folder with + Add New Project.</Notice>}
      {params.get('oauth') === 'error' && <Notice tone="bad" title="Google account connection failed">{params.get('reason') ?? 'Unknown error'}. Nothing was saved.</Notice>}
      <PageTitle eyebrow="Project Hub" title="Choose a project">
        <Button variant="ghost" onClick={() => setShowArchived((s) => !s)} aria-pressed={showArchived}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
        <Button variant="primary" onClick={() => setParams({ new: '1' })}>
          <span aria-hidden>+</span> Add new project
        </Button>
      </PageTitle>

      {!configured && (
        <EmptyState title="Data service not configured">
          Set <code className="num">VITE_SUPABASE_URL</code> and <code className="num">VITE_SUPABASE_ANON_KEY</code> for this deployment.
        </EmptyState>
      )}
      {configured && dir.isLoading && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}
      {configured && dir.isError && <EmptyState title="Projects could not be loaded">The data service is unreachable. Retrying automatically.</EmptyState>}
      {configured && dir.data && rows.length === 0 && (
        <EmptyState title="No projects yet" action={<Button variant="primary" onClick={() => setParams({ new: '1' })}>Add new project</Button>}>
          Choose a Google Drive folder for EDCS, DIE or any other project. Each one gets its own main modules, dashboards, sources and validation.
        </EmptyState>
      )}

      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((p) => {
          const stale = isStale(p.last_verified_at, now, p.stale_threshold_minutes);
          return (
            <li key={p.project_id}>
              <Link to={`/projects/${p.project_id}`} className="group block h-full rounded-2xl">
                <Card className="flex h-full flex-col p-6 transition-[border-color,box-shadow,transform] duration-200 group-hover:-translate-y-0.5 group-hover:border-line-strong group-hover:shadow-[0_18px_40px_-28px_rgba(11,27,51,0.45)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold tracking-tight text-ink">{p.name}</h2>
                      <p className="num mt-0.5 text-xs text-ink-3">{p.project_id}</p>
                    </div>
                    <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-semibold ${STATE_TONE[p.run_state ?? 'Pending']}`}>{p.run_state ?? 'Pending'}</span>
                  </div>
                  <dl className="mt-6 grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <dt className="text-xs text-ink-3">Main modules</dt>
                      <dd className="num mt-0.5 text-xl font-semibold text-ink">{p.main_module_count}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-3">Submodules</dt>
                      <dd className="num mt-0.5 text-xl font-semibold text-ink">{p.module_count}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-3">Sources</dt>
                      <dd className="num mt-0.5 text-xl font-semibold text-ink">{p.source_count}</dd>
                    </div>
                  </dl>
                  <div className="mt-6 flex items-center justify-between border-t border-line pt-4 text-xs">
                    <span className="text-ink-3">
                      {p.last_verified_at ? <>Verified {relative(p.last_verified_at, now)}</> : 'Never verified'}
                      {stale && <span className="ml-2 font-semibold text-warn">Stale</span>}
                      {p.archived_at && <span className="ml-2 font-semibold text-warn">Archived</span>}
                    </span>
                    <span aria-hidden className="font-medium text-accent transition-transform group-hover:translate-x-0.5">Open →</span>
                  </div>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
      <AddProjectDialog open={adding} onClose={() => setParams({})} />
    </div>
  );
}
