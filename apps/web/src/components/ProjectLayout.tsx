import { createContext, useContext } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { dateTime, isStale } from '../lib/format';
import { useDirectory, useLiveProject, useNow, useProjectState, useSnapshot } from '../lib/data';
import type { DirectoryRow, ProjectState, PublicSnapshot } from '../lib/types';
import { EmptyState, Notice, Skeleton } from './ui';
import { ValidationStatus } from './ValidationStatus';

interface ProjectCtx {
  projectId: string;
  project: DirectoryRow;
  snapshot: PublicSnapshot | null;
  state: ProjectState | null;
}
const Ctx = createContext<ProjectCtx | null>(null);
export const useProject = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useProject outside ProjectLayout');
  return c;
};

export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const dir = useDirectory();
  const snap = useSnapshot(projectId);
  const state = useProjectState(projectId);
  const live = useLiveProject(projectId);
  const now = useNow();
  const project = dir.data?.find((p) => p.project_id === projectId);

  if (dir.isLoading) return <Skeleton className="h-40" />;
  if (dir.isError) return <EmptyState title="Dashboard data is unavailable">The data service could not be reached. Retrying automatically.</EmptyState>;
  if (!project) {
    return (
      <EmptyState title="Project not found" action={<Link className="text-sm font-medium text-accent underline-offset-4 hover:underline" to="/projects">View all projects</Link>}>
        No project with the id <span className="num font-medium">{projectId}</span> exists.
      </EmptyState>
    );
  }

  const s = snap.data ?? null;
  const st = state.data ?? null;
  const stale = isStale(s?.published_at ?? null, now, project.stale_threshold_minutes);
  const failed = st?.run_state === 'Validation Failed' || st?.run_state === 'Sync Failed';

  return (
    <Ctx.Provider value={{ projectId, project, snapshot: s, state: st }}>
      <header className="no-print mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
        <div className="flex items-center gap-3">
          {/* Active-project label (MP-FR-010) */}
          <span className="inline-flex h-7 items-center rounded-md bg-navy px-2.5 text-xs font-semibold tracking-wide text-navy-ink">{project.name}</span>
          <span className="text-sm text-ink-3">
            Project <span className="num">{project.project_id}</span>
            {project.archived_at && <span className="ml-2 font-medium text-warn">Archived</span>}
          </span>
        </div>
        <ValidationStatus state={st} snapshot={s} live={live} staleMinutes={project.stale_threshold_minutes} />
      </header>
      {s && failed && (
        <Notice tone="bad" title={st?.run_state === 'Sync Failed' ? 'Latest synchronization failed' : 'Latest update failed validation'}>
          Showing the last verified snapshot from {dateTime(s.published_at)}. The unverified update was not published.
        </Notice>
      )}
      {s && stale && !failed && (
        <Notice tone="warn" title="Data is stale">
          The last verified snapshot is older than {project.stale_threshold_minutes} minutes ({dateTime(s.published_at)}).
        </Notice>
      )}
      <Outlet />
    </Ctx.Provider>
  );
}

/** Wrap pages that need a published snapshot; never renders fabricated zeros (FR-DES-004). */
export function RequireSnapshot({ children }: { children: (s: PublicSnapshot) => React.ReactNode }) {
  const { snapshot, state, projectId } = useProject();
  const snap = useSnapshot(projectId);
  if (snap.isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
        <Skeleton className="h-72 sm:col-span-2 xl:col-span-4" />
      </div>
    );
  }
  if (!snapshot) {
    const running = state?.run_state === 'Validating' || state?.run_state === 'Pending';
    return (
      <EmptyState
        title="No validated snapshot yet"
        action={<Link to={`/projects/${projectId}/sources`} className="text-sm font-medium text-accent underline-offset-4 hover:underline">Manage data sources</Link>}
      >
        {state?.run_state === 'Validation Failed' || state?.run_state === 'Sync Failed'
          ? `The latest run ended with “${state.run_state}”. Nothing is shown until all mandatory checks pass.`
          : running && state?.last_attempt_at
            ? 'A synchronization is in progress. Results appear automatically once all five checks pass.'
            : 'Connect a document to this project. Its modules appear once the data is read and validated.'}
      </EmptyState>
    );
  }
  return <>{children(snapshot)}</>;
}
