// Synchronize exactly one project. Invoked by sync-dispatch or admin-api (worker secret required).
import { assertProjectId, json, requireWorkerSecret, serve } from '../_shared/http.ts';
import { syncProject, type Trigger } from '../_shared/sync.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

serve(async (req) => {
  requireWorkerSecret(req);
  const { projectId, trigger = 'schedule', wait = false } = await req.json();
  const id = assertProjectId(projectId);
  const job = syncProject(id, trigger as Trigger);
  if (wait) return json(req, await job);
  EdgeRuntime.waitUntil(job);
  return json(req, { accepted: id }, 202);
});
