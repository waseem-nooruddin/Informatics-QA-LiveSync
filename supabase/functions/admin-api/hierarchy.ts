// SRS V1.5 routes: Google Drive Picker flows (FR-GD-001..008), main modules, the review
// (quarantine) queue, unlink impact preview and approval records.
import { classifySheet, DEFAULT_RULESET, slugify } from '../_shared/core/index.ts';
import { accessTokenWithExpiry } from '../_shared/adapters/oauth.ts';
import { inspectItem, listSubfolders, listWorkbooks, workbookSheets, type DriveItemInfo } from '../_shared/adapters/drive.ts';
import { SourceError } from '../_shared/adapters/types.ts';
import { audit, db, must, requireAdmin, type AdminContext } from '../_shared/db.ts';
import { assertProjectId, HttpError, json, MODULE_ID_RE } from '../_shared/http.ts';

type Handler = (req: Request, p: Record<string, string>, url: URL) => Promise<Response>;
type Route = (method: string, pattern: string, h: Handler) => void;

export interface Helpers {
  body: (req: Request) => Promise<any>;
  project: (id: string) => Promise<any>;
  triggerSync: (projectId: string, trigger: string) => Promise<void>;
  requireMainModule: (projectId: string, mainModuleId: string) => Promise<string>;
}

const actor = (a: AdminContext) => `admin:${a.label}`;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Accept a picker id or a pasted Drive URL (the supported fallback when the Picker is blocked). */
export function driveIdFrom(input: string): string {
  const s = String(input ?? '').trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  const id = m ? m[1]! : s;
  if (!DRIVE_ID_RE.test(id)) throw new HttpError(400, 'INVALID_DRIVE_ITEM', 'Not a valid Google Drive folder or file link/ID');
  return id;
}

async function googleCredential(projectId: string | null): Promise<{ id: string; account_ref: string }> {
  let q = db().from('source_credentials').select('id,account_ref').eq('provider', 'google').is('revoked_at', null).order('created_at', { ascending: false }).limit(1);
  q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null);
  const { data } = await q;
  const c = data?.[0];
  if (!c) throw new HttpError(409, 'GOOGLE_ACCOUNT_REQUIRED', 'Connect a Google account with read-only Drive access first');
  return c;
}

function driveError(e: unknown): never {
  if (e instanceof SourceError) {
    const status = e.code === 'ACCESS_DENIED' ? 403 : e.code === 'NOT_FOUND' ? 404 : 422;
    throw new HttpError(status, e.code, e.message);
  }
  throw e;
}

/** Valid submodule tabs a workbook would contribute (same classifier the sync uses). */
async function detectTabs(projectId: string | null, credId: string, item: DriveItemInfo) {
  const sheets = await workbookSheets(projectId, credId, item);
  const tabs = sheets.map((s) => ({ title: s.title, ...classifySheet(s, DEFAULT_RULESET) }));
  return {
    submodules: tabs.filter((t) => t.kind === 'module').map((t) => t.title),
    defectRegisters: tabs.filter((t) => t.kind === 'defects').map((t) => t.title),
    skipped: tabs.filter((t) => t.kind === 'skipped').map((t) => ({ title: t.title, reason: t.reason })),
  };
}

const providerFor = (k: DriveItemInfo['kind']) => (k === 'folder' ? 'google-drive-folder' : k === 'google-sheet' ? 'google-sheets' : 'google-drive-xlsx');

export function registerHierarchyRoutes(route: Route, h: Helpers) {
  // ── Picker configuration: short-lived token only; refresh tokens never leave the server (FR-GD-005)
  route('GET', '/picker-config', async (req, _p, url) => {
    const projectId = url.searchParams.get('projectId');
    if (projectId) assertProjectId(projectId);
    await requireAdmin(req, projectId ?? undefined);
    const apiKey = Deno.env.get('GOOGLE_PICKER_API_KEY');
    const appId = Deno.env.get('GOOGLE_CLOUD_PROJECT_NUMBER') ?? '';
    if (!apiKey) throw new HttpError(501, 'PICKER_NOT_CONFIGURED', 'The Google Picker API key is not configured on the server; use a folder link instead');
    const cred = await googleCredential(projectId);
    const { token, expiresAt } = await accessTokenWithExpiry(projectId, cred.id, 'google');
    return json(req, { apiKey, appId, accessToken: token, expiresAt, account: cred.account_ref });
  });

  // ── + Add New Project: preview a picked Drive folder (FR-GD-002) — read-only, creates nothing
  route('POST', '/projects/preview-from-folder', async (req) => {
    await requireAdmin(req);
    const b = await h.body(req);
    const folderId = driveIdFrom(b.folderId ?? b.folderUrl);
    const cred = await googleCredential(null);
    try {
      const folder = await inspectItem(null, cred.id, folderId);
      if (folder.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', `“${folder.name}” is not a folder. Choose the project's Drive folder.`);
      const conflicts: string[] = [];
      const { data: rooted } = await db().from('project_roots').select('project_id').eq('provider', 'google').eq('folder_id', folderId).maybeSingle();
      if (rooted) conflicts.push(`This folder is already the source root of project “${rooted.project_id}”.`);
      const subfolders = await listSubfolders(null, cred.id, folderId);
      const mainModules = [];
      for (const f of subfolders.slice(0, 50)) {
        const books = await listWorkbooks(null, cred.id, f.id);
        const tabs: string[] = [];
        for (const wb of books.slice(0, 10)) tabs.push(...(await detectTabs(null, cred.id, wb)).submodules);
        const { data: linked } = await db().from('source_connections').select('project_id').eq('external_id', f.id).neq('state', 'removed');
        if (linked?.length) conflicts.push(`Subfolder “${f.name}” is already linked to project “${linked[0]!.project_id}”.`);
        mainModules.push({ folderId: f.id, name: f.name, workbooks: books.length, submodules: tabs, supported: books.length > 0, alreadyLinked: !!linked?.length });
      }
      const proposedId = slugify(folder.name).slice(0, 40);
      return json(req, { folder: { id: folder.id, name: folder.name }, account: cred.account_ref, proposedName: folder.name, proposedId, mainModules, conflicts });
    } catch (e) {
      driveError(e);
    }
  });

  // ── YES: create the isolated project, its main modules and mappings (FR-GD-002)
  route('POST', '/projects/from-folder', async (req) => {
    const a = await requireAdmin(req);
    const b = await h.body(req);
    if (b.confirm !== 'YES') throw new HttpError(400, 'CONFIRMATION_REQUIRED', 'Answer YES to “Create this project from the selected Google Drive folder?”');
    const folderId = driveIdFrom(b.folderId);
    const id = assertProjectId(String(b.id ?? '').trim().toLowerCase());
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'INVALID_NAME', 'Display name is required (max 120 chars)');
    const selected: { folderId: string; name: string }[] = Array.isArray(b.mainModules) ? b.mainModules : [];
    const cred = await googleCredential(null);
    const sb = db();
    // Re-validate server-side before creating anything.
    let folder: DriveItemInfo;
    try {
      folder = await inspectItem(null, cred.id, folderId);
    } catch (e) {
      driveError(e);
    }
    if (folder.kind !== 'folder') throw new HttpError(400, 'NOT_A_FOLDER', 'The selected item is not a folder');
    const { data: rooted } = await sb.from('project_roots').select('project_id').eq('provider', 'google').eq('folder_id', folderId).maybeSingle();
    if (rooted) throw new HttpError(409, 'FOLDER_ALREADY_ROOTED', `This folder already roots project “${rooted.project_id}”`);
    const subfolders = await listSubfolders(null, cred.id, folderId).catch(driveError);
    const valid = selected.filter((s) => subfolders.some((f) => f.id === s.folderId));
    if (valid.length !== selected.length) throw new HttpError(400, 'INVALID_MAIN_MODULE', 'A selected main module is not a subfolder of the chosen folder');

    must(await sb.rpc('create_project', { p_id: id, p_name: name, p_actor: actor(a) }), 'create project');
    const credId = must(await sb.rpc('clone_credential', { p_id: cred.id, p_project: id }), 'clone credential') as string;
    must(await sb.from('project_roots').insert({ project_id: id, folder_id: folderId, folder_name: folder.name, account_ref: cred.account_ref, credential_id: credId }), 'project root');
    const used = new Set<string>();
    for (const s of valid) {
      let mid = slugify(s.name) || 'module';
      for (let i = 2; used.has(mid); i++) mid = `${slugify(s.name)}-${i}`;
      used.add(mid);
      const display = String(s.name).trim().slice(0, 120) || mid;
      must(await sb.from('main_modules').insert({ project_id: id, id: mid, name: display, drive_folder_id: s.folderId }), 'main module');
      must(await sb.from('source_connections').insert({
        project_id: id, main_module_id: mid, provider: 'google-drive-folder', external_id: s.folderId, display_name: display, credential_id: credId, created_by: actor(a),
      }), 'main module folder');
    }
    await audit(id, actor(a), 'project.created_from_drive', { folderId, folderName: folder.name, mainModules: valid.map((v) => v.name), account: cred.account_ref });
    await h.triggerSync(id, 'source-added');
    return json(req, { id, name, mainModules: [...used] }, 201);
  });

  // ── Main modules (manual creation, rename, archive)
  route('POST', '/projects/:id/main-modules', async (req, p) => {
    const id = assertProjectId(p.id);
    const a = await requireAdmin(req, id);
    const b = await h.body(req);
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'INVALID_NAME', 'Main module name is required');
    const mid = String(b.id ?? slugify(name)).toLowerCase();
    if (!MODULE_ID_RE.test(mid)) throw new HttpError(400, 'INVALID_MAIN_MODULE_ID', 'Invalid main module id');
    const { error } = await db().from('main_modules').insert({ project_id: id, id: mid, name });
    if (error) throw new HttpError(409, 'MAIN_MODULE_EXISTS', `Main module “${mid}” already exists`);
    await audit(id, actor(a), 'main_module.created', { mainModuleId: mid, name });
    return json(req, { id: mid, name }, 201);
  });

  route('PATCH', '/projects/:id/main-modules/:mid', async (req, p) => {
    const id = assertProjectId(p.id);
    const a = await requireAdmin(req, id);
    const b = await h.body(req);
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name || name.length > 120) throw new HttpError(400, 'INVALID_NAME', 'Main module name is required');
      patch.name = name;
    }
    if (b.active !== undefined) {
      patch.active = !!b.active;
      patch.archived_at = b.active ? null : new Date().toISOString();
    }
    const r = must(await db().from('main_modules').update(patch).eq('project_id', id).eq('id', p.mid).select('id'), 'main module');
    if (!r.length) throw new HttpError(404, 'MAIN_MODULE_NOT_FOUND', 'Main module not found');
    await audit(id, actor(a), 'main_module.updated', { mainModuleId: p.mid, ...patch });
    await h.triggerSync(id, 'manual');
    return json(req, { id: p.mid, ...patch });
  });

  // ── + Add on a main module: preview picked items (FR-GD-004) — read-only
  route('POST', '/projects/:id/main-modules/:mid/sources/preview', async (req, p) => {
    const id = assertProjectId(p.id);
    await requireAdmin(req, id);
    const mid = await h.requireMainModule(id, p.mid!);
    const b = await h.body(req);
    const ids: string[] = (Array.isArray(b.items) ? b.items : []).slice(0, 25).map((x: string) => driveIdFrom(x));
    if (!ids.length) throw new HttpError(400, 'NOTHING_SELECTED', 'Select at least one document or folder');
    const cred = await googleCredential(id);
    const sb = db();
    const items = [];
    for (const itemId of [...new Set(ids)]) {
      try {
        const info = await inspectItem(id, cred.id, itemId);
        const { data: here } = await sb.from('source_connections').select('main_module_id').eq('project_id', id).eq('external_id', itemId).neq('state', 'removed').maybeSingle();
        const { data: other } = await sb.from('source_connections').select('project_id').eq('external_id', itemId).neq('project_id', id).neq('state', 'removed').limit(1);
        let result = 'add';
        let note = '';
        if (info.kind === 'unsupported') [result, note] = ['skip', 'Unsupported format'];
        else if (here) [result, note] = ['skip', here.main_module_id === mid ? 'Already linked to this main module' : `Already linked to main module “${here.main_module_id}”`];
        else if (other?.length) [result, note] = ['skip', `Linked to another project (“${other[0]!.project_id}”)`];
        let detected: string[] = [];
        if (result === 'add' && info.kind !== 'folder') detected = (await detectTabs(id, cred.id, info)).submodules;
        if (result === 'add' && info.kind === 'folder') detected = (await listWorkbooks(id, cred.id, info.id)).map((w) => `${w.name} (workbook)`);
        items.push({ id: info.id, name: info.name, kind: info.kind, result, note, detected });
      } catch (e) {
        const msg = e instanceof SourceError ? e.message : 'Could not read this item';
        items.push({ id: itemId, name: itemId, kind: 'unknown', result: 'skip', note: msg, detected: [] });
      }
    }
    return json(req, { project: id, mainModule: mid, items });
  });

  // ── YES: attach to the selected project → main module only (FR-GD-004/006)
  route('POST', '/projects/:id/main-modules/:mid/sources', async (req, p) => {
    const id = assertProjectId(p.id);
    const a = await requireAdmin(req, id);
    const mid = await h.requireMainModule(id, p.mid!);
    const b = await h.body(req);
    if (b.confirm !== 'YES' || b.confirmProjectId !== id || b.confirmMainModuleId !== mid) {
      throw new HttpError(400, 'CONFIRMATION_REQUIRED', `Answer YES to “Add these Google Drive sources to ${id} → ${mid}?”`);
    }
    const ids: string[] = [...new Set<string>((Array.isArray(b.items) ? b.items : []).slice(0, 25).map((x: string) => driveIdFrom(x)))];
    const cred = await googleCredential(id);
    const sb = db();
    const added: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const itemId of ids) {
      let info: DriveItemInfo;
      try {
        info = await inspectItem(id, cred.id, itemId);
      } catch (e) {
        skipped.push({ id: itemId, reason: e instanceof SourceError ? e.code : 'ERROR' });
        continue;
      }
      if (info.kind === 'unsupported') {
        skipped.push({ id: itemId, reason: 'UNSUPPORTED_TYPE' });
        continue;
      }
      const { error } = await sb.from('source_connections').insert({
        project_id: id, main_module_id: mid, provider: providerFor(info.kind), external_id: info.id, display_name: info.name.slice(0, 200), credential_id: cred.id, created_by: actor(a),
      });
      if (error) skipped.push({ id: itemId, reason: /SOURCE_IN_OTHER_PROJECT/.test(error.message) ? 'SOURCE_IN_OTHER_PROJECT' : 'ALREADY_LINKED' });
      else added.push(info.name);
    }
    await audit(id, actor(a), 'source.attached', { mainModuleId: mid, added, skipped });
    if (added.length) await h.triggerSync(id, 'source-added');
    return json(req, { added, skipped }, added.length ? 201 : 200);
  });

  // ── Review (quarantine) queue (V1.5 §5.2, AT-10)
  route('GET', '/projects/:id/reviews', async (req, p) => {
    const id = assertProjectId(p.id);
    await requireAdmin(req, id);
    return json(req, must(await db().from('mapping_reviews').select('*').eq('project_id', id).order('created_at', { ascending: false }).limit(200), 'reviews'));
  });

  route('POST', '/projects/:id/reviews/:rid', async (req, p) => {
    const id = assertProjectId(p.id);
    const a = await requireAdmin(req, id);
    const b = await h.body(req);
    const sb = db();
    const r = must(await sb.from('mapping_reviews').select('*').eq('project_id', id).eq('id', p.rid).maybeSingle(), 'review');
    if (!r) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review item not found');
    if (r.status !== 'open') throw new HttpError(409, 'REVIEW_DECIDED', 'This item was already decided');
    const action = String(b.action ?? '');
    const resolution: Record<string, unknown> = { action };
    if (action === 'ignore') {
      // nothing else: the sheet/folder stays excluded
    } else if (action === 'same-submodule' && r.kind === 'submodule-name-collision') {
      const { data: src } = await sb.from('source_documents').select('connection_id').eq('project_id', id).eq('file_id', r.file_id).maybeSingle();
      must(await sb.from('module_mappings').insert({
        project_id: id, file_id: r.file_id, sheet_id: r.sheet_id, main_module_id: r.main_module_id, module_id: r.candidate_module_id, source_id: src?.connection_id ?? 'review', sheet_title: r.title,
      }), 'mapping');
      resolution.moduleId = r.candidate_module_id;
    } else if (action === 'new-submodule' && r.kind === 'submodule-name-collision') {
      const name = String(b.name ?? '').trim();
      if (!name) throw new HttpError(400, 'NAME_REQUIRED', 'Give the new submodule a distinct name');
      let sid = slugify(name);
      for (let i = 2; (await sb.from('modules').select('id').eq('project_id', id).eq('id', sid).maybeSingle()).data; i++) sid = `${slugify(name)}-${i}`;
      must(await sb.from('modules').insert({ project_id: id, main_module_id: r.main_module_id, id: sid, name }), 'submodule');
      const { data: src } = await sb.from('source_documents').select('connection_id').eq('project_id', id).eq('file_id', r.file_id).maybeSingle();
      must(await sb.from('module_mappings').insert({
        project_id: id, file_id: r.file_id, sheet_id: r.sheet_id, main_module_id: r.main_module_id, module_id: sid, source_id: src?.connection_id ?? 'review', sheet_title: r.title,
      }), 'mapping');
      resolution.moduleId = sid;
    } else if (action === 'add-main-module' && r.kind === 'unknown-folder') {
      const name = String(b.name ?? r.title).trim().slice(0, 120);
      const mid = slugify(name);
      must(await sb.from('main_modules').insert({ project_id: id, id: mid, name, drive_folder_id: r.file_id }), 'main module');
      const { data: root } = await sb.from('project_roots').select('credential_id').eq('project_id', id).maybeSingle();
      must(await sb.from('source_connections').insert({
        project_id: id, main_module_id: mid, provider: 'google-drive-folder', external_id: r.file_id, display_name: name, credential_id: root?.credential_id ?? null, created_by: actor(a),
      }), 'folder source');
      resolution.mainModuleId = mid;
    } else {
      throw new HttpError(400, 'INVALID_ACTION', 'Unsupported action for this review item');
    }
    must(await sb.from('mapping_reviews').update({
      status: action === 'ignore' ? 'ignored' : 'resolved', resolution, resolved_at: new Date().toISOString(), resolved_by: actor(a),
    }).eq('project_id', id).eq('id', p.rid), 'resolve review');
    await audit(id, actor(a), 'review.decided', { reviewId: p.rid, kind: r.kind, ...resolution });
    await h.triggerSync(id, 'manual');
    return json(req, { id: p.rid, ...resolution });
  });

  // ── Unlink impact preview (FR-GD-007): what disappears from navigation and totals
  route('GET', '/projects/:id/sources/:sid/impact', async (req, p) => {
    const id = assertProjectId(p.id);
    await requireAdmin(req, id);
    const sb = db();
    const conn = must(await sb.from('source_connections').select('id,display_name,main_module_id').eq('project_id', id).eq('id', p.sid).maybeSingle(), 'source');
    if (!conn) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source not found in this project');
    const docs = must(await sb.from('source_documents').select('file_id').eq('project_id', id).eq('connection_id', p.sid), 'docs') as { file_id: string }[];
    const maps = must(await sb.from('module_mappings').select('module_id,file_id').eq('project_id', id), 'maps') as { module_id: string; file_id: string }[];
    const files = new Set(docs.map((d) => d.file_id));
    const affected = [...new Set(maps.filter((m) => files.has(m.file_id)).map((m) => m.module_id))];
    const sole = affected.filter((mid) => maps.filter((m) => m.module_id === mid).every((m) => files.has(m.file_id)));
    const pr = await h.project(id);
    let totals: { moduleId: string; moduleName: string; totalTc: number; openDefects: number }[] = [];
    if (pr.current_snapshot_id) {
      const { data: snap } = await sb.from('snapshots').select('payload').eq('project_id', id).eq('id', pr.current_snapshot_id).single();
      totals = ((snap?.payload?.table?.rows ?? []) as any[]).filter((r) => sole.includes(r.moduleId)).map((r) => ({ moduleId: r.moduleId, moduleName: r.moduleName, totalTc: r.totalTc, openDefects: r.openDefects }));
    }
    return json(req, { source: conn.display_name, mainModuleId: conn.main_module_id, submodulesArchived: sole, submodulesAffected: affected, removedFromTotals: totals, driveContentDeleted: false });
  });

  route('GET', '/approvals', async (req) => {
    await requireAdmin(req);
    return json(req, must(await db().from('approval_records').select('*').order('approved_at', { ascending: false }), 'approvals'));
  });
}
