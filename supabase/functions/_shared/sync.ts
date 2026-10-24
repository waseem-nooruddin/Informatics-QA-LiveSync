import {
  resolveRuleset,
  runPipeline,
  sheetKey,
  validate,
  type IndependentCounts,
  type MainModuleEntry,
  type MappingReview,
  type ModuleEntry,
  type ModuleMapping,
  type RawSheet,
  type RawWorkbook,
  type Ruleset,
  type SourceOutcome,
} from './core/index.ts';
import { adapterFor, SourceError, type Connection, type DocRef } from './adapters/index.ts';
import { listSubfolders } from './adapters/drive.ts';
import { audit, db, must } from './db.ts';
import { sha256Hex } from './http.ts';

export type Trigger = 'schedule' | 'manual' | 'change-event' | 'source-added';

export interface SyncSummary {
  projectId: string;
  runId: string | null;
  state: string;
  snapshotId?: string;
  detail?: string;
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

async function loadRuleset(projectId: string, version: string, staleMinutes: number): Promise<Ruleset> {
  const { data } = await db().from('ruleset_versions').select('version,ruleset,provisional').eq('project_id', projectId).eq('version', version).maybeSingle();
  const rs = resolveRuleset((data?.ruleset ?? {}) as Partial<Ruleset>);
  return { ...rs, version: data?.version ?? rs.version, provisional: data?.provisional ?? true, staleThresholdMinutes: staleMinutes };
}

/** One complete, isolated synchronization of a single project (MP-FR-024..028). */
export async function syncProject(projectId: string, trigger: Trigger, depth = 0): Promise<SyncSummary> {
  const sb = db();
  const project = must(await sb.from('projects').select('*').eq('id', projectId).maybeSingle(), 'load project');
  if (!project) return { projectId, runId: null, state: 'Skipped', detail: 'unknown project' };
  if (project.archived_at) return { projectId, runId: null, state: 'Skipped', detail: 'archived' };

  const run = must(await sb.from('sync_runs').insert({ project_id: projectId, trigger }).select('id,version').single(), 'create run');
  const runId: string = run.id;
  const leased = must(await sb.rpc('acquire_sync_lease', { p_project: projectId, p_run: runId, p_seconds: 600 }), 'lease');
  if (!leased) {
    await sb.from('sync_runs').update({ state: 'Superseded', finished_at: new Date().toISOString(), error_codes: ['LEASE_HELD'] }).eq('project_id', projectId).eq('id', runId);
    return { projectId, runId, state: 'Superseded', detail: 'another run holds the lease' };
  }
  log({ msg: 'sync.start', projectId, runId, version: run.version, trigger });

  try {
    const settings = must(await sb.from('project_settings').select('*').eq('project_id', projectId).single(), 'settings');
    const rs = await loadRuleset(projectId, project.ruleset_version, settings.stale_threshold_minutes);
    const conns = must(await sb.from('source_connections').select('*').eq('project_id', projectId).neq('state', 'removed'), 'connections') as (Connection & { state: string })[];
    const knownDocs = must(await sb.from('source_documents').select('*').eq('project_id', projectId), 'documents') as Record<string, any>[];
    const cache = must(await sb.from('source_cache').select('file_id,revision,sheets').eq('project_id', projectId), 'cache') as { file_id: string; revision: string; sheets: RawSheet[] }[];
    const dbMainModules = must(await sb.from('main_modules').select('*').eq('project_id', projectId), 'main modules') as Record<string, any>[];
    const dbModules = must(await sb.from('modules').select('*').eq('project_id', projectId), 'modules') as Record<string, any>[];
    const dbReviews = must(await sb.from('mapping_reviews').select('key,status,file_id,sheet_id').eq('project_id', projectId), 'reviews') as Record<string, any>[];
    const ignoredSheetKeys = dbReviews.filter((r) => r.status === 'ignored' && r.sheet_id).map((r) => sheetKey(r.file_id, r.sheet_id));
    const dbMappings = must(await sb.from('module_mappings').select('*').eq('project_id', projectId), 'mappings') as Record<string, any>[];

    // ── Read sources ──────────────────────────────────────────────────────────
    const workbooks: RawWorkbook[] = [];
    const outcomes: SourceOutcome[] = [];
    // Only sources attached to a main module carry data; a project-root folder is watched for new subfolders.
    const active = conns.filter((c) => c.state === 'active' && c.main_module_id);
    const inactiveFiles = new Set(knownDocs.filter((d) => !active.some((c) => c.id === d.connection_id)).map((d) => d.file_id as string));

    for (const conn of active) {
      const adapter = adapterFor(conn.provider);
      let docs: DocRef[];
      try {
        docs = await adapter.list(conn);
      } catch (e) {
        const err = e instanceof SourceError ? e : new SourceError('NETWORK', (e as Error).message);
        const affected = knownDocs.filter((d) => d.connection_id === conn.id);
        for (const d of affected.length ? affected : [{ file_id: conn.external_id, display_name: conn.display_name }]) {
          outcomes.push({ sourceId: conn.id, fileId: d.file_id, fileName: d.display_name, provider: providerOf(conn), state: 'failed', revision: null, errorCode: err.code, errorMessage: err.message });
        }
        await markHealth(projectId, affected.map((d) => d.file_id), err.code === 'NOT_FOUND' ? 'missing' : 'failing', err.message);
        continue;
      }
      // Files previously under this connection that disappeared (moved/removed) → source issue (MP-FR-017).
      for (const d of knownDocs.filter((k) => k.connection_id === conn.id && !docs.some((x) => x.fileId === k.file_id))) {
        const hasModules = dbMappings.some((m) => m.file_id === d.file_id && dbModules.find((x) => x.id === m.module_id)?.active);
        await markHealth(projectId, [d.file_id], 'missing', 'File no longer present in the connected location');
        if (hasModules) {
          outcomes.push({ sourceId: conn.id, fileId: d.file_id, fileName: d.display_name, provider: providerOf(conn), state: 'failed', revision: null, errorCode: 'NOT_FOUND', errorMessage: 'File was moved or removed' });
        }
      }
      for (const doc of docs) {
        await sb.from('source_documents').upsert(
          { project_id: projectId, connection_id: conn.id, file_id: doc.fileId, display_name: doc.displayName, file_type: doc.fileType, parent_ref: doc.parentRef, modified_at: doc.modifiedAt, last_read_at: new Date().toISOString() },
          { onConflict: 'project_id,file_id' },
        );
        const cached = cache.find((c) => c.file_id === doc.fileId);
        try {
          let sheets: RawSheet[];
          let state: SourceOutcome['state'];
          if (cached && cached.revision === doc.revision && doc.revision) {
            sheets = cached.sheets;
            state = 'unchanged';
          } else {
            sheets = await readConsistent(conn, doc);
            state = 'read';
            await sb.from('source_cache').upsert({ project_id: projectId, file_id: doc.fileId, revision: doc.revision, sheets, cached_at: new Date().toISOString() }, { onConflict: 'project_id,file_id' });
          }
          workbooks.push({ projectId, mainModuleId: conn.main_module_id!, sourceId: conn.id, provider: providerOf(conn), fileId: doc.fileId, fileName: doc.displayName, revision: doc.revision, modifiedAt: doc.modifiedAt, sheets });
          outcomes.push({ sourceId: conn.id, fileId: doc.fileId, fileName: doc.displayName, provider: providerOf(conn), state, revision: doc.revision });
          await sb.from('source_documents').update({ revision: doc.revision, last_success_at: new Date().toISOString(), health: 'healthy', health_detail: null }).eq('project_id', projectId).eq('file_id', doc.fileId);
        } catch (e) {
          const err = e instanceof SourceError ? e : new SourceError('NETWORK', (e as Error).message);
          outcomes.push({ sourceId: conn.id, fileId: doc.fileId, fileName: doc.displayName, provider: providerOf(conn), state: 'failed', revision: null, errorCode: err.code, errorMessage: err.message });
          await markHealth(projectId, [doc.fileId], err.code === 'UNSUPPORTED_TYPE' ? 'unsupported' : 'failing', err.message);
        }
      }
    }

    // New subfolders under the project's Drive root are never assumed to be main modules (V1.5 §5.2).
    const folderReviews = await watchProjectRoot(projectId, dbMainModules);

    const mainModules: MainModuleEntry[] = dbMainModules.map((m) => ({ projectId, mainModuleId: m.id, name: m.name, active: m.active }));
    // Submodules owned solely by disabled/removed sources are excluded under the archival policy.
    const modules: ModuleEntry[] = dbModules.map((m) => {
      const maps = dbMappings.filter((x) => x.module_id === m.id);
      const orphaned = maps.length > 0 && maps.every((x) => inactiveFiles.has(x.file_id));
      return { projectId, mainModuleId: m.main_module_id, moduleId: m.id, name: m.name, active: m.active && !orphaned };
    });
    const mappings: ModuleMapping[] = dbMappings.map((m) => ({ projectId, mainModuleId: m.main_module_id, moduleId: m.module_id, sourceId: m.source_id, fileId: m.file_id, sheetId: m.sheet_id, sheetTitle: m.sheet_title }));

    // ── No-change detection (FR-SYNC-011) ─────────────────────────────────────
    // The fingerprint covers source revisions, rules and the module registry; a run stores the
    // post-discovery fingerprint so the next unchanged run matches it exactly.
    const rsHash = await sha256Hex(JSON.stringify(rs));
    const fingerprintOf = (maps: ModuleMapping[], mods: ModuleEntry[]) =>
      sha256Hex(JSON.stringify({
        revs: outcomes.map((o) => `${o.fileId}@${o.revision}:${o.state === 'failed' ? 'F' : 'ok'}`).sort(),
        rs: rs.version,
        rsHash,
        maps: maps.map((m) => `${sheetKey(m.fileId, m.sheetId)}>${m.mainModuleId}/${m.moduleId}:${m.sheetTitle}`).sort(),
        mods: mods.map((m) => `${m.mainModuleId}/${m.moduleId}:${m.name}:${m.active}`).sort(),
        mains: mainModules.map((m) => `${m.mainModuleId}:${m.name}:${m.active}`).sort(),
        ignored: [...ignoredSheetKeys].sort(),
        cols: settings.explicit_columns,
      }));
    const fingerprint = await fingerprintOf(mappings, modules);
    const sourceHealth = healthOf(outcomes);
    const allOk = outcomes.every((o) => o.state !== 'failed');
    if (allOk && project.current_snapshot_id) {
      const { data: last } = await sb.from('snapshots').select('run_id').eq('project_id', projectId).eq('id', project.current_snapshot_id).single();
      const { data: lastRun } = await sb.from('sync_runs').select('fingerprint').eq('project_id', projectId).eq('id', last!.run_id).single();
      if (lastRun?.fingerprint === fingerprint) {
        await sb.from('sync_runs').update({ fingerprint, source_outcomes: outcomes }).eq('project_id', projectId).eq('id', runId);
        await sb.rpc('record_run_outcome', { p_project: projectId, p_run: runId, p_state: 'No Change', p_gates: null, p_source_health: sourceHealth, p_error: null });
        log({ msg: 'sync.no_change', projectId, runId });
        return { projectId, runId, state: 'No Change' };
      }
    }

    // ── Pipeline ──────────────────────────────────────────────────────────────
    const prev = project.current_snapshot_id
      ? (await sb.from('snapshots').select('payload').eq('project_id', projectId).eq('id', project.current_snapshot_id).single()).data
      : null;
    const previousModuleTc: Record<string, number> = {};
    for (const r of (prev?.payload?.table?.rows ?? []) as { moduleId: string; totalTc: number }[]) previousModuleTc[r.moduleId] = r.totalTc;

    const result = runPipeline({
      projectId,
      rs,
      mappingVersion: `m${project.mapping_version}`,
      workbooks,
      sources: outcomes,
      mainModules,
      modules,
      ignoredSheetKeys,
      mappings,
      explicitColumns: settings.explicit_columns ?? {},
      previousModuleTc,
    });

    // Persist discovery (new modules / renamed sheets) — registry is never deleted here.
    const newModules = result.discovery.modules.filter((m) => !dbModules.some((d) => d.id === m.moduleId));
    if (newModules.length) must(await sb.from('modules').insert(newModules.map((m) => ({ project_id: projectId, main_module_id: m.mainModuleId, id: m.moduleId, name: m.name }))), 'insert modules');
    for (const m of result.discovery.mappings) {
      const existing = dbMappings.find((d) => d.file_id === m.fileId && d.sheet_id === m.sheetId);
      if (!existing) {
        must(await sb.from('module_mappings').insert({ project_id: projectId, file_id: m.fileId, sheet_id: m.sheetId, main_module_id: m.mainModuleId, module_id: m.moduleId, source_id: m.sourceId, sheet_title: m.sheetTitle }), 'insert mapping');
      } else if (existing.sheet_title !== m.sheetTitle) {
        await sb.from('module_mappings').update({ sheet_title: m.sheetTitle }).eq('project_id', projectId).eq('file_id', m.fileId).eq('sheet_id', m.sheetId);
      }
    }
    for (const wb of workbooks) {
      const rows = wb.sheets.map((s) => {
        const ms = result.discovery.moduleSheets.find((x) => x.workbook.fileId === wb.fileId && x.sheet.sheetId === s.sheetId);
        const ds = result.discovery.defectSheets.find((x) => x.workbook.fileId === wb.fileId && x.sheet.sheetId === s.sheetId);
        const skipped = result.discovery.events.find((e) => e.type === 'sheet-skipped' && e.fileName === wb.fileName && e.sheet === s.title);
        return {
          project_id: projectId, file_id: wb.fileId, sheet_id: s.sheetId, title: s.title,
          kind: ms ? 'module' : ds ? 'defects' : 'skipped',
          reason: skipped && skipped.type === 'sheet-skipped' ? skipped.reason : null,
          last_seen_at: new Date().toISOString(),
        };
      });
      if (rows.length) await sb.from('source_worksheets').upsert(rows, { onConflict: 'project_id,file_id,sheet_id' });
    }
    for (const e of result.discovery.events) {
      if (e.type === 'module-created' || e.type === 'sheet-renamed' || e.type === 'sheet-missing') await audit(projectId, 'worker', `discovery.${e.type}`, { runId, ...e });
    }
    // Quarantine: ambiguous items wait for an administrator; decided items are never reopened.
    await queueReviews(projectId, [...result.discovery.reviews, ...folderReviews]);

    // Stage canonical records, then reconcile through an independent SQL path (FR-VAL-006).
    await insertChunks('canonical_tests', result.tests.map((t) => ({
      project_id: projectId, run_id: runId, main_module_id: t.mainModuleId, module_id: t.moduleId, test_case_id: t.testCaseId, status: t.status,
      executed_at: t.executedAt, lineage: t.lineage, executions: t.executions.length,
    })));
    await insertChunks('canonical_defects', result.defects.map((d) => ({
      project_id: projectId, run_id: runId, defect_id: d.defectId, main_module_id: d.mainModuleId, module_id: d.moduleId, lifecycle: d.lifecycle,
      raw_status: d.rawStatus, severity: d.severity, priority: d.priority, lineage: d.lineage,
    })));
    const sqlCounts = must(await sb.rpc('reconcile_counts', { p_project: projectId, p_run: runId }), 'reconcile') as IndependentCounts;
    const report = validate({ ...result.validationInput, independent: [...result.validationInput.independent, { label: 'sql-independent', counts: sqlCounts }] });

    const gateSummary = report.gates.map((g) => ({ id: g.id, name: g.name, state: g.state, blocking: g.blocking, discrepancyCount: g.discrepancies.length }));
    must(await sb.from('validation_results').insert({
      project_id: projectId, run_id: runId, gates: report.gates, publishable: report.publishable, run_state: report.runState,
      counts: report.counts, issues: result.issues.slice(0, 2000), decisions: [...result.discovery.decisions].slice(0, 2000),
      conflicts: [...result.discovery.conflicts, ...result.validationInput.conflicts].slice(0, 2000),
      ruleset_version: rs.version, mapping_version: result.candidate.mappingVersion,
    }), 'store validation');
    const postFingerprint = await fingerprintOf(result.discovery.mappings, result.discovery.modules);
    await sb.from('sync_runs').update({ fingerprint: postFingerprint, source_outcomes: outcomes, error_codes: outcomes.filter((o) => o.errorCode).map((o) => o.errorCode!) }).eq('project_id', projectId).eq('id', runId);

    if (!report.publishable) {
      const first = report.gates.find((g) => g.blocking && g.state !== 'Passed');
      await sb.rpc('record_run_outcome', {
        p_project: projectId, p_run: runId, p_state: report.runState, p_gates: gateSummary, p_source_health: sourceHealth,
        p_error: first ? `${first.id} ${first.name}: ${first.discrepancies.length} discrepancies` : null,
      });
      log({ msg: 'sync.not_published', projectId, runId, state: report.runState });
      return { projectId, runId, state: report.runState };
    }

    const c = result.candidate;
    // Option A: aggregates only — file ids and source ids never leave the server.
    const publicPayload = {
      hierarchy: c.hierarchy,
      table: {
        overall: c.table.overall,
        mainModules: c.table.mainModules,
        rows: c.table.rows.map((r) => ({ ...r, sources: r.sources.map((s) => ({ sheetTitle: s.sheetTitle })) })),
      },
      charts: c.charts,
      kpis: c.kpis,
      rules: {
        severityCategories: rs.severityCategories,
        priorityCategories: rs.priorityCategories,
        otherStatuses: rs.otherStatuses,
        defectPopulation: rs.defectPopulation,
        passRatioDenominator: rs.passRatioDenominator,
        dsi: rs.dsi,
      },
    };
    const { data: snapId, error } = await sb.rpc('publish_snapshot', {
      p_project: projectId, p_run: runId, p_source_cutoff: c.sourceCutoff, p_ruleset_version: c.rulesetVersion,
      p_ruleset_provisional: c.rulesetProvisional, p_mapping_version: c.mappingVersion,
      p_payload: { ...c, discoveryEvents: result.discovery.events }, p_public_payload: publicPayload,
      p_validation: { runState: report.runState, gates: gateSummary, counts: report.counts }, p_gates: gateSummary, p_source_health: sourceHealth,
    });
    if (error) {
      if (/STALE_RUN/.test(error.message)) {
        await sb.rpc('record_run_outcome', { p_project: projectId, p_run: runId, p_state: 'Superseded', p_gates: null, p_source_health: null, p_error: null });
        return { projectId, runId, state: 'Superseded', detail: 'newer snapshot already published' };
      }
      throw new Error(error.message);
    }
    log({ msg: 'sync.published', projectId, runId, snapshotId: snapId });
    return { projectId, runId, state: 'Validated', snapshotId: snapId as string };
  } catch (e) {
    const msg = (e as Error).message;
    log({ msg: 'sync.error', projectId, runId, error: msg });
    await sb.rpc('record_run_outcome', { p_project: projectId, p_run: runId, p_state: 'Sync Failed', p_gates: null, p_source_health: null, p_error: 'Internal synchronization error' });
    return { projectId, runId, state: 'Sync Failed', detail: msg };
  } finally {
    // A change that arrived while this run held the lease gets an immediate follow-up run.
    const { data: rerun } = await sb.rpc('release_sync_lease', { p_project: projectId, p_run: runId });
    if (rerun && depth < 3) {
      log({ msg: 'sync.follow_up', projectId, runId });
      await syncProject(projectId, 'manual', depth + 1); // awaited so the worker invocation stays alive
    }
  }
}

/** Read, then confirm the revision did not change mid-read; retry once (edge case §16). */
async function readConsistent(conn: Connection, doc: DocRef): Promise<RawSheet[]> {
  const adapter = adapterFor(conn.provider);
  for (let attempt = 0; attempt < 2; attempt++) {
    const sheets = await adapter.read(conn, doc);
    const after = await adapter.revision(conn, doc);
    if (after === doc.revision) return sheets;
    doc.revision = after;
  }
  throw new SourceError('REVISION_CHANGED', `"${doc.displayName}" kept changing during retrieval`);
}

function providerOf(conn: Connection): RawWorkbook['provider'] {
  if (conn.provider === 'upload') return 'upload';
  if (conn.provider.startsWith('onedrive')) return 'onedrive';
  return conn.provider === 'google-sheets' ? 'google-sheets' : 'google-drive-xlsx';
}

function healthOf(outcomes: SourceOutcome[]) {
  return {
    total: outcomes.length,
    healthy: outcomes.filter((o) => o.state !== 'failed').length,
    failing: outcomes.filter((o) => o.state === 'failed').length,
    unchanged: outcomes.filter((o) => o.state === 'unchanged').length,
  };
}

async function markHealth(projectId: string, fileIds: string[], health: string, detail: string) {
  if (!fileIds.length) return;
  await db().from('source_documents').update({ health, health_detail: detail.slice(0, 500) }).eq('project_id', projectId).in('file_id', fileIds);
}

async function insertChunks(table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) must(await db().from(table).insert(rows.slice(i, i + 500)), `insert ${table}`);
}

/** Upsert open reviews; an item already resolved or ignored stays decided. */
async function queueReviews(projectId: string, reviews: MappingReview[]) {
  if (!reviews.length) return;
  const rows = reviews.map((r) => ({
    project_id: projectId, key: r.key, kind: r.kind, main_module_id: r.mainModuleId, file_id: r.fileId, sheet_id: r.sheetId,
    title: r.title, detail: r.detail, candidate_module_id: r.candidateModuleId ?? null,
  }));
  await db().from('mapping_reviews').upsert(rows, { onConflict: 'project_id,key', ignoreDuplicates: true });
}

/** Subfolders of the project's Drive root that are not yet main modules become 'unknown-folder' reviews. */
async function watchProjectRoot(projectId: string, mainModules: Record<string, any>[]): Promise<MappingReview[]> {
  const { data: root } = await db().from('project_roots').select('*').eq('project_id', projectId).maybeSingle();
  if (!root?.credential_id) return [];
  try {
    const folders = await listSubfolders(projectId, root.credential_id, root.folder_id);
    const known = new Set(mainModules.map((m) => m.drive_folder_id).filter(Boolean));
    return folders.filter((f) => !known.has(f.id)).map((f) => ({
      kind: 'unknown-folder' as const,
      key: `${projectId}|folder:${f.id}`,
      projectId,
      mainModuleId: null,
      fileId: f.id,
      sheetId: null,
      title: f.name,
      detail: `Subfolder “${f.name}” appeared in the project's Drive folder. Unknown folders are never assumed to be main modules.`,
    }));
  } catch (e) {
    log({ msg: 'sync.root_watch_failed', projectId, error: (e as Error).message });
    return [];
  }
}
