// Privileged management API (SEC-003, MP-06). Every route requires an admin key;
// project-scoped routes additionally verify the key's scope.
import { adapterFor, SourceError, type Connection } from '../_shared/adapters/index.ts';
import { accessToken, GOOGLE_SCOPES, MICROSOFT_SCOPES } from '../_shared/adapters/oauth.ts';
import { audit, db, must, requireAdmin, type AdminContext } from '../_shared/db.ts';
import { assertProjectId, HttpError, json, MODULE_ID_RE, serve, sha256Hex } from '../_shared/http.ts';
import { signState } from '../_shared/state.ts';
import { registerHierarchyRoutes } from './hierarchy.ts';

type Handler = (req: Request, p: Record<string, string>, url: URL) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), h]);

const actor = (a: AdminContext) => `admin:${a.label}`;
const body = async (req: Request) => {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be JSON');
  }
};

async function project(id: string) {
  const p = must(await db().from('projects').select('*').eq('id', id).maybeSingle(), 'project');
  if (!p) throw new HttpError(404, 'PROJECT_NOT_FOUND', `Project "${id}" not found`);
  return p;
}

async function requireMainModule(projectId: string, mainModuleId: string): Promise<string> {
  if (!MODULE_ID_RE.test(mainModuleId)) throw new HttpError(400, 'MAIN_MODULE_REQUIRED', 'Choose the main module these sources belong to');
  const m = must(await db().from('main_modules').select('id,active').eq('project_id', projectId).eq('id', mainModuleId).maybeSingle(), 'main module');
  if (!m) throw new HttpError(404, 'MAIN_MODULE_NOT_FOUND', `Main module "${mainModuleId}" does not exist in this project`);
  if (!m.active) throw new HttpError(409, 'MAIN_MODULE_ARCHIVED', 'Restore the main module before adding sources');
  return m.id;
}

async function triggerSync(projectId: string, trigger: string) {
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/sync-project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': Deno.env.get('WORKER_SECRET')! },
    body: JSON.stringify({ projectId, trigger }),
  }).then((r) => r.body?.cancel()).catch(() => undefined);
}

// ── Identity ──────────────────────────────────────────────────────────────────
route('GET', '/whoami', async (req, _p, url) => {
  const a = await requireAdmin(req, url.searchParams.get('projectId') ?? undefined);
  return json(req, { label: a.label, scope: a.scope });
});

// ── Projects (MP-01, MP-06) ───────────────────────────────────────────────────
route('POST', '/projects', async (req) => {
  const a = await requireAdmin(req);
  const b = await body(req);
  const id = assertProjectId(String(b.id ?? '').trim().toLowerCase());
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'INVALID_NAME', 'Display name is required (max 120 chars)');
  const p = must(await db().rpc('create_project', { p_id: id, p_name: name, p_actor: actor(a) }), 'create project');
  return json(req, p, 201);
});

route('PATCH', '/projects/:id', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const b = await body(req);
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 120) throw new HttpError(400, 'INVALID_NAME', 'Display name is required');
  const before = await project(id);
  must(await db().from('projects').update({ name }).eq('id', id), 'rename');
  await audit(id, actor(a), 'project.renamed', { from: before.name, to: name });
  return json(req, { id, name });
});

for (const action of ['archive', 'restore'] as const) {
  route('POST', `/projects/:id/${action}`, async (req, p) => {
    const id = assertProjectId(p.id);
    const a = await requireAdmin(req);
    const b = await body(req);
    if (b.confirm !== id) throw new HttpError(400, 'CONFIRMATION_REQUIRED', `Type the project id "${id}" to confirm`);
    await project(id);
    must(await db().from('projects').update({ archived_at: action === 'archive' ? new Date().toISOString() : null }).eq('id', id), action);
    await audit(id, actor(a), `project.${action}d`, {});
    return json(req, { id, archived: action === 'archive' });
  });
}

// ── Sources (MP-03, FR-SRC-*) ─────────────────────────────────────────────────
route('GET', '/projects/:id/sources', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  const sb = db();
  const [conns, docs, sheets, maps, creds, mains, reviews, root] = await Promise.all([
    sb.from('source_connections').select('id,provider,external_id,display_name,state,created_at,credential_id,main_module_id').eq('project_id', id).neq('state', 'removed').order('created_at'),
    sb.from('source_documents').select('connection_id,file_id,display_name,file_type,revision,modified_at,last_read_at,last_success_at,health,health_detail').eq('project_id', id),
    sb.from('source_worksheets').select('file_id,sheet_id,title,kind,reason,last_seen_at').eq('project_id', id),
    sb.from('module_mappings').select('file_id,sheet_id,main_module_id,module_id').eq('project_id', id),
    sb.from('source_credentials').select('id,provider,account_ref,created_at,revoked_at').eq('project_id', id),
    sb.from('main_modules').select('id,name,drive_folder_id,active').eq('project_id', id).order('name'),
    sb.from('mapping_reviews').select('id,kind,main_module_id,title,detail,candidate_module_id,status,created_at').eq('project_id', id).eq('status', 'open').order('created_at'),
    sb.from('project_roots').select('folder_id,folder_name,account_ref').eq('project_id', id).maybeSingle(),
  ]);
  return json(req, {
    connections: conns.data ?? [],
    documents: docs.data ?? [],
    worksheets: sheets.data ?? [],
    mappings: maps.data ?? [],
    credentials: creds.data ?? [],
    mainModules: mains.data ?? [],
    reviews: reviews.data ?? [],
    root: root.data ?? null,
  });
});

/** Parse a Google URL into a connection provider + file/folder id. */
function parseGoogle(input: string): { provider: Connection['provider']; externalId: string } {
  const s = input.trim();
  let m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return { provider: 'google-sheets', externalId: m[1]! };
  m = /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return { provider: 'google-drive-folder', externalId: m[1]! };
  m = /drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return { provider: 'google-drive-xlsx', externalId: m[1]! };
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return { provider: 'google-sheets', externalId: s };
  throw new HttpError(400, 'INVALID_SOURCE_URL', 'Not a recognised Google Sheets / Drive file or folder URL');
}

async function resolveOneDrive(projectId: string, credentialId: string, input: string) {
  const s = input.trim();
  if (!/^https:\/\/([a-z0-9-]+\.)*(1drv\.ms|onedrive\.live\.com|sharepoint\.com)\//i.test(s)) {
    throw new HttpError(400, 'INVALID_SOURCE_URL', 'Not a recognised OneDrive / SharePoint sharing URL');
  }
  const token = await accessToken(projectId, credentialId, 'microsoft');
  const enc = 'u!' + btoa(s).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${enc}/driveItem?$select=id,name,folder,file,parentReference`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new HttpError(422, 'SOURCE_UNREACHABLE', `OneDrive item could not be resolved (HTTP ${res.status})`);
  const it = await res.json();
  return { provider: (it.folder ? 'onedrive-folder' : 'onedrive') as Connection['provider'], externalId: `${it.parentReference.driveId}!${it.id}`, name: it.name as string };
}

route('POST', '/projects/:id/sources', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const b = await body(req);
  // MP-FR-012: destination project confirmed explicitly by the client.
  if (b.confirmProjectId !== id) throw new HttpError(400, 'DESTINATION_NOT_CONFIRMED', `Confirm the destination project "${id}"`);
  const p0 = await project(id);
  if (p0.archived_at) throw new HttpError(409, 'PROJECT_ARCHIVED', 'Restore the project before adding sources');
  const mainModuleId = await requireMainModule(id, String(b.mainModuleId ?? ''));
  if (b.confirmMainModuleId !== mainModuleId) throw new HttpError(400, 'DESTINATION_NOT_CONFIRMED', 'Confirm the destination main module');
  const credentialId = String(b.credentialId ?? '');
  if (!credentialId) throw new HttpError(400, 'CREDENTIAL_REQUIRED', 'Connect an account first');
  let parsed: { provider: Connection['provider']; externalId: string; name?: string };
  if (b.provider === 'google') parsed = parseGoogle(String(b.url ?? ''));
  else if (b.provider === 'microsoft') parsed = await resolveOneDrive(id, credentialId, String(b.url ?? ''));
  else throw new HttpError(400, 'INVALID_PROVIDER', 'provider must be google or microsoft (use /upload for files)');

  const conn: Connection = {
    id: crypto.randomUUID(), project_id: id, provider: parsed.provider, external_id: parsed.externalId,
    display_name: String(b.displayName ?? parsed.name ?? parsed.externalId).slice(0, 200), credential_id: credentialId, storage_path: null,
  };
  // Verify reachability & type before saving (FR-SRC-007).
  let docs;
  try {
    docs = await adapterFor(conn.provider).list(conn);
  } catch (e) {
    if (e instanceof SourceError) throw new HttpError(422, e.code, e.message);
    throw e;
  }
  must(await db().from('source_connections').insert({ ...conn, main_module_id: mainModuleId, created_by: actor(a) }), 'insert connection');
  await audit(id, actor(a), 'source.added', { connectionId: conn.id, mainModuleId, provider: conn.provider, externalId: conn.external_id, documents: docs.length });
  await triggerSync(id, 'source-added');
  return json(req, { connectionId: conn.id, provider: conn.provider, documents: docs.map((d) => d.displayName) }, 201);
});

const ALLOWED_UPLOAD = /\.(xlsx|xls|csv)$/i;

route('POST', '/projects/:id/sources/upload', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const form = await req.formData();
  if (form.get('confirmProjectId') !== id) throw new HttpError(400, 'DESTINATION_NOT_CONFIRMED', `Confirm the destination project "${id}"`);
  const file = form.get('file');
  if (!(file instanceof File) || !ALLOWED_UPLOAD.test(file.name)) throw new HttpError(400, 'INVALID_FILE', 'Upload an .xlsx, .xls or .csv file');
  if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'FILE_TOO_LARGE', 'Maximum 25 MB');
  const p0 = await project(id);
  if (p0.archived_at) throw new HttpError(409, 'PROJECT_ARCHIVED', 'Restore the project before adding sources');
  const replaceId = form.get('connectionId');
  const replacing = typeof replaceId === 'string' && replaceId.length > 0;
  // New uploads are attached to exactly one main module (V1.5 §5.3).
  const mainModuleId = replacing ? null : await requireMainModule(id, String(form.get('mainModuleId') ?? ''));
  const bytes = new Uint8Array(await file.arrayBuffer());
  const revision = await sha256Hex(bytes);
  const sb = db();
  let connId: string;
  if (replacing) {
    const existing = must(await sb.from('source_connections').select('id,provider').eq('project_id', id).eq('id', replaceId).maybeSingle(), 'connection');
    if (!existing || existing.provider !== 'upload') throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Upload source not found in this project');
    connId = existing.id;
  } else {
    connId = crypto.randomUUID();
  }
  const ext = file.name.split('.').pop()!.toLowerCase();
  const path = `${id}/${connId}/workbook.${ext}`;
  let up = await sb.storage.from('sources').upload(path, bytes, { upsert: true, contentType: file.type || 'application/octet-stream' });
  if (up.error && /bucket not found/i.test(up.error.message)) {
    await sb.storage.createBucket('sources', { public: false, fileSizeLimit: 25 * 1024 * 1024 });
    up = await sb.storage.from('sources').upload(path, bytes, { upsert: true, contentType: file.type || 'application/octet-stream' });
  }
  if (up.error) throw new Error(up.error.message);
  const displayName = String(form.get('displayName') || file.name).slice(0, 200);
  if (!replacing) {
    must(await sb.from('source_connections').insert({ id: connId, project_id: id, main_module_id: mainModuleId, provider: 'upload', external_id: `upload:${connId}`, display_name: displayName, storage_path: path, created_by: actor(a) }), 'insert connection');
  } else {
    await sb.from('source_connections').update({ storage_path: path }).eq('project_id', id).eq('id', connId);
  }
  // Uploads keep one stable file_id per connection so re-uploads update, not duplicate, modules.
  must(await sb.from('source_documents').upsert({
    project_id: id, connection_id: connId, file_id: `upload-${connId}`, display_name: displayName, file_type: ext,
    revision, modified_at: new Date().toISOString(), health: 'unknown',
  }, { onConflict: 'project_id,file_id' }), 'upsert document');
  await audit(id, actor(a), replacing ? 'source.file_replaced' : 'source.added', { connectionId: connId, provider: 'upload', fileName: file.name, revision });
  await triggerSync(id, 'source-added');
  return json(req, { connectionId: connId, revision }, 201);
});

route('PATCH', '/projects/:id/sources/:sid', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const b = await body(req);
  if (!['active', 'disabled'].includes(b.state)) throw new HttpError(400, 'INVALID_STATE', 'state must be active or disabled');
  const r = must(await db().from('source_connections').update({ state: b.state }).eq('project_id', id).eq('id', p.sid).neq('state', 'removed').select('id'), 'update source');
  if (!r.length) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source not found in this project');
  await audit(id, actor(a), `source.${b.state === 'active' ? 'enabled' : 'disabled'}`, { connectionId: p.sid });
  await triggerSync(id, 'manual');
  return json(req, { id: p.sid, state: b.state });
});

route('DELETE', '/projects/:id/sources/:sid', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const b = await body(req);
  if (b.confirm !== id) throw new HttpError(400, 'CONFIRMATION_REQUIRED', `Type the project id "${id}" to confirm removal`);
  const sb = db();
  const docs = must(await sb.from('source_documents').select('file_id').eq('project_id', id).eq('connection_id', p.sid), 'docs') as { file_id: string }[];
  const fileIds = docs.map((d) => d.file_id);
  // Retention policy: records & snapshots are kept; modules owned solely by this source are archived.
  const maps = fileIds.length ? (must(await sb.from('module_mappings').select('module_id,file_id').eq('project_id', id), 'maps') as { module_id: string; file_id: string }[]) : [];
  const owned = [...new Set(maps.filter((m) => fileIds.includes(m.file_id)).map((m) => m.module_id))].filter(
    (mid) => maps.filter((m) => m.module_id === mid).every((m) => fileIds.includes(m.file_id)),
  );
  const r = must(await sb.from('source_connections').update({ state: 'removed' }).eq('project_id', id).eq('id', p.sid).select('id'), 'remove');
  if (!r.length) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source not found in this project');
  if (owned.length) await sb.from('modules').update({ active: false, archived_at: new Date().toISOString() }).eq('project_id', id).in('id', owned);
  await audit(id, actor(a), 'source.removed', { connectionId: p.sid, archivedModules: owned });
  await triggerSync(id, 'manual');
  return json(req, { removed: p.sid, archivedModules: owned });
});

route('POST', '/projects/:id/source-exceptions', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req); // platform admin only (MP-FR-018)
  const b = await body(req);
  if (!b.provider || !b.externalId || !String(b.reason ?? '').trim()) throw new HttpError(400, 'INVALID_EXCEPTION', 'provider, externalId and reason are required');
  must(await db().from('source_project_exceptions').insert({ provider: b.provider, external_id: b.externalId, project_id: id, reason: b.reason, approved_by: actor(a) }), 'exception');
  await audit(id, actor(a), 'source.exception_approved', { provider: b.provider, externalId: b.externalId, reason: b.reason });
  return json(req, { ok: true }, 201);
});

// ── Modules ───────────────────────────────────────────────────────────────────
for (const action of ['archive', 'restore'] as const) {
  route('POST', `/projects/:id/modules/:mid/${action}`, async (req, p) => {
    const id = assertProjectId(p.id);
    if (!MODULE_ID_RE.test(p.mid!)) throw new HttpError(400, 'INVALID_MODULE_ID', 'Invalid module id');
    const a = await requireAdmin(req, id);
    const r = must(await db().from('modules').update({ active: action === 'restore', archived_at: action === 'archive' ? new Date().toISOString() : null }).eq('project_id', id).eq('id', p.mid).select('id'), action);
    if (!r.length) throw new HttpError(404, 'MODULE_NOT_FOUND', 'Module not found');
    await audit(id, actor(a), `module.${action}d`, { moduleId: p.mid });
    await triggerSync(id, 'manual');
    return json(req, { moduleId: p.mid, active: action === 'restore' });
  });
}

/** Sensitive record-level drill-down for the current snapshot (FR-TBL-005, SEC-006). */
route('GET', '/projects/:id/modules/:mid/records', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  const pr = await project(id);
  if (!pr.current_snapshot_id) return json(req, { tests: [], defects: [] });
  const sb = db();
  const snap = must(await sb.from('snapshots').select('id,run_id').eq('project_id', id).eq('id', pr.current_snapshot_id).single(), 'snapshot');
  const [tests, defects] = await Promise.all([
    sb.from('canonical_tests').select('test_case_id,status,executed_at,lineage,executions').eq('project_id', id).eq('run_id', snap.run_id).eq('module_id', p.mid).order('test_case_id').limit(5000),
    sb.from('canonical_defects').select('defect_id,lifecycle,raw_status,severity,priority,lineage').eq('project_id', id).eq('run_id', snap.run_id).eq('module_id', p.mid).order('defect_id').limit(5000),
  ]);
  return json(req, { snapshotId: snap.id, tests: tests.data ?? [], defects: defects.data ?? [] });
});

// ── Runs, evidence, audit, diff ───────────────────────────────────────────────
route('POST', '/projects/:id/sync', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  await project(id);
  await audit(id, actor(a), 'sync.requested', {});
  await triggerSync(id, 'manual');
  return json(req, { accepted: id }, 202);
});

route('GET', '/projects/:id/runs', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  const r = must(await db().from('sync_runs').select('id,version,trigger,state,started_at,finished_at,error_codes').eq('project_id', id).order('started_at', { ascending: false }).limit(50), 'runs');
  return json(req, r);
});

route('GET', '/projects/:id/runs/:runId', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  const sb = db();
  const run = must(await sb.from('sync_runs').select('*').eq('project_id', id).eq('id', p.runId).maybeSingle(), 'run');
  if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
  const v = (await sb.from('validation_results').select('*').eq('project_id', id).eq('run_id', p.runId).maybeSingle()).data;
  return json(req, { run, validation: v });
});

route('GET', '/projects/:id/audit', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  return json(req, must(await db().from('audit_log').select('at,actor,action,detail').eq('project_id', id).order('at', { ascending: false }).limit(200), 'audit'));
});

route('GET', '/projects/:id/snapshots', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  return json(req, must(await db().from('snapshots').select('id,version,published_at,ruleset_version,mapping_version').eq('project_id', id).order('version', { ascending: false }).limit(100), 'snapshots'));
});

/** Why did a number change between two snapshots? (FR-AUD-003, AT-014) */
route('GET', '/projects/:id/diff', async (req, p, url) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  const sb = db();
  const get = async (sid: string | null) => {
    if (!sid) throw new HttpError(400, 'SNAPSHOT_REQUIRED', 'from and to snapshot ids are required');
    const s = must(await sb.from('snapshots').select('id,run_id,version,ruleset_version,mapping_version,payload').eq('project_id', id).eq('id', sid).maybeSingle(), 'snapshot');
    if (!s) throw new HttpError(404, 'SNAPSHOT_NOT_FOUND', `Snapshot ${sid} not found in ${id}`);
    const t = must(await sb.from('canonical_tests').select('module_id,test_case_id,status,lineage').eq('project_id', id).eq('run_id', s.run_id).limit(100000), 'tests') as any[];
    const d = must(await sb.from('canonical_defects').select('module_id,defect_id,lifecycle,severity,priority,lineage').eq('project_id', id).eq('run_id', s.run_id).limit(100000), 'defects') as any[];
    return { s, t, d };
  };
  const [a, b] = await Promise.all([get(url.searchParams.get('from')), get(url.searchParams.get('to'))]);
  const key = (x: any) => `${x.module_id}|${x.test_case_id ?? x.defect_id}`;
  const diffSets = (xs: any[], ys: any[], cmp: (x: any) => string) => {
    const A = new Map(xs.map((x) => [key(x), x]));
    const B = new Map(ys.map((y) => [key(y), y]));
    return {
      added: [...B.keys()].filter((k) => !A.has(k)).map((k) => B.get(k)),
      removed: [...A.keys()].filter((k) => !B.has(k)).map((k) => A.get(k)),
      changed: [...B.keys()].filter((k) => A.has(k) && cmp(A.get(k)) !== cmp(B.get(k))).map((k) => ({ from: A.get(k), to: B.get(k) })),
    };
  };
  const rowsA = new Map((a.s.payload.table.modules as any[]).map((r) => [r.moduleId, r]));
  const aggregates = (b.s.payload.table.modules as any[]).flatMap((r) => {
    const o = rowsA.get(r.moduleId);
    const fields = ['totalTc', 'passed', 'failed', 'blocked', 'notTested', 'openDefects', 'closedDefects'];
    const ch = fields.filter((f) => !o || o[f] !== r[f]).map((f) => ({ field: f, from: o?.[f] ?? null, to: r[f] }));
    return ch.length ? [{ moduleId: r.moduleId, moduleName: r.moduleName, changes: ch }] : [];
  });
  return json(req, {
    from: { id: a.s.id, version: a.s.version, ruleset: a.s.ruleset_version, mapping: a.s.mapping_version },
    to: { id: b.s.id, version: b.s.version, ruleset: b.s.ruleset_version, mapping: b.s.mapping_version },
    rulesChanged: a.s.ruleset_version !== b.s.ruleset_version || a.s.mapping_version !== b.s.mapping_version,
    aggregates,
    tests: diffSets(a.t, b.t, (x) => x.status),
    defects: diffSets(a.d, b.d, (x) => `${x.lifecycle}|${x.severity}|${x.priority}`),
  });
});

// ── Rulesets (approved definitions, DSI enablement) ───────────────────────────
const RULESET_KEYS = new Set(['testStatusAliases', 'defectStatusAliases', 'severityCategories', 'severityAliases', 'priorityCategories', 'priorityAliases', 'columnAliases', 'excludedSheetPatterns', 'dateOrder', 'defectPopulation', 'dsi', 'sourcePrecedence']);

route('GET', '/projects/:id/ruleset', async (req, p) => {
  const id = assertProjectId(p.id);
  await requireAdmin(req, id);
  const pr = await project(id);
  const versions = must(await db().from('ruleset_versions').select('*').eq('project_id', id).order('created_at', { ascending: false }), 'rulesets');
  return json(req, { active: pr.ruleset_version, versions });
});

route('PUT', '/projects/:id/ruleset', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const b = await body(req);
  const version = String(b.version ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(version)) throw new HttpError(400, 'INVALID_VERSION', 'version label required (A–Z, 0–9, . _ -)');
  const rs = b.ruleset ?? {};
  for (const k of Object.keys(rs)) if (!RULESET_KEYS.has(k)) throw new HttpError(400, 'INVALID_RULESET', `Unknown ruleset field "${k}"`);
  if (rs.dsi) {
    const d = rs.dsi;
    const ok = typeof d.version === 'string' && d.weights && typeof d.weights === 'object' && Object.values(d.weights).every((w) => typeof w === 'number' && isFinite(w as number))
      && ['all', 'open'].includes(d.population) && ['none', 'totalTc', 'defects'].includes(d.denominator) && ['fail', 'exclude'].includes(d.missingSeverity) && Number.isInteger(d.decimals);
    if (!ok) throw new HttpError(400, 'INVALID_DSI', 'DSI formula needs version, numeric weights, population, denominator, missingSeverity and decimals');
  }
  for (const pat of rs.excludedSheetPatterns ?? []) {
    try {
      new RegExp(pat);
    } catch {
      throw new HttpError(400, 'INVALID_PATTERN', `Invalid sheet pattern ${pat}`);
    }
  }
  const approvedBy = String(b.approvedBy ?? '').trim();
  must(await db().from('ruleset_versions').insert({
    project_id: id, version, ruleset: rs, provisional: !approvedBy, approved_by: approvedBy || null, approved_at: approvedBy ? new Date().toISOString() : null,
  }), 'insert ruleset');
  must(await db().from('projects').update({ ruleset_version: version }).eq('id', id), 'activate ruleset');
  await audit(id, actor(a), 'ruleset.activated', { version, approvedBy: approvedBy || null, dsiEnabled: !!rs.dsi });
  await triggerSync(id, 'manual');
  return json(req, { active: version, provisional: !approvedBy });
});

route('PUT', '/projects/:id/settings', async (req, p) => {
  const id = assertProjectId(p.id);
  const a = await requireAdmin(req, id);
  const b = await body(req);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.staleThresholdMinutes !== undefined) {
    const n = Number(b.staleThresholdMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) throw new HttpError(400, 'INVALID_THRESHOLD', '1–1440 minutes');
    patch.stale_threshold_minutes = n;
  }
  if (b.explicitColumns !== undefined) patch.explicit_columns = b.explicitColumns;
  if (b.exportSettings !== undefined) patch.export_settings = b.exportSettings;
  must(await db().from('project_settings').update(patch).eq('project_id', id), 'settings');
  await audit(id, actor(a), 'settings.updated', patch);
  return json(req, { ok: true });
});

registerHierarchyRoutes(route, { body, project, triggerSync, requireMainModule });

// ── OAuth start (account connection) ──────────────────────────────────────────
// No projectId = a platform-level account, used by "+ Add New Project" before a project exists.
route('GET', '/oauth/start', async (req, _p, url) => {
  const rawProject = url.searchParams.get('projectId');
  const projectId = rawProject ? assertProjectId(rawProject) : null;
  await requireAdmin(req, projectId ?? undefined);
  const provider = url.searchParams.get('provider');
  const redirect = `${Deno.env.get('SUPABASE_URL')}/functions/v1/oauth-callback`;
  const state = await signState({ p: projectId, pr: provider, exp: Date.now() + 10 * 60_000 });
  if (provider === 'google') {
    const id = Deno.env.get('GOOGLE_CLIENT_ID');
    if (!id) throw new HttpError(501, 'PROVIDER_NOT_CONFIGURED', 'Google OAuth client is not configured on the server');
    const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', scope: ['openid', 'email', ...GOOGLE_SCOPES].join(' '), state });
    return json(req, { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
  }
  if (provider === 'microsoft') {
    const id = Deno.env.get('MICROSOFT_CLIENT_ID');
    if (!id) throw new HttpError(501, 'PROVIDER_NOT_CONFIGURED', 'Microsoft OAuth client is not configured on the server');
    const tenant = Deno.env.get('MICROSOFT_TENANT') ?? 'common';
    const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', response_mode: 'query', scope: MICROSOFT_SCOPES.join(' '), state });
    return json(req, { url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${q}` });
  }
  throw new HttpError(400, 'INVALID_PROVIDER', 'provider must be google or microsoft');
});

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/admin-api/, '') || '/';
  for (const [method, re, h] of routes) {
    const m = re.exec(path);
    if (m && method === req.method) return h(req, (m.groups ?? {}) as Record<string, string>, url);
  }
  throw new HttpError(404, 'NOT_FOUND', 'Unknown admin route');
});
