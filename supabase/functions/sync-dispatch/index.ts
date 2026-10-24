// Cron entry (every 3 minutes): fan out one isolated sync per active project (MP-FR-024/026).
import { db, must } from '../_shared/db.ts';
import { json, requireWorkerSecret, serve } from '../_shared/http.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

serve(async (req) => {
  requireWorkerSecret(req);
  const body = await req.json().catch(() => ({}));
  const projects = must(await db().from('projects').select('id').is('archived_at', null), 'list projects') as { id: string }[];
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/sync-project`;
  const secret = Deno.env.get('WORKER_SECRET')!;
  // Each project is a separate invocation, so one project's failure never blocks another.
  const calls = projects.map((p) =>
    fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret },
      body: JSON.stringify({ projectId: p.id, trigger: body.trigger ?? 'schedule' }),
    }).then((r) => r.body?.cancel()).catch((e) => console.error(JSON.stringify({ msg: 'dispatch.failed', projectId: p.id, error: String(e) }))),
  );
  EdgeRuntime.waitUntil(Promise.allSettled(calls));
  return json(req, { dispatched: projects.map((p) => p.id) }, 202);
});
