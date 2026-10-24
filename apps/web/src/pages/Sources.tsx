import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdminKeyInline } from '../components/AdminKey';
import { useProject } from '../components/ProjectLayout';
import { Breadcrumbs, Button, Card, Dialog, EmptyState, Field, inputCls, Notice, PageTitle } from '../components/ui';
import { admin, useAdminKey } from '../lib/admin';
import { dateTime } from '../lib/format';

interface SourcesResp {
  connections: { id: string; provider: string; external_id: string; display_name: string; state: string; created_at: string; credential_id: string | null; main_module_id: string | null }[];
  documents: { connection_id: string; file_id: string; display_name: string; last_success_at: string | null; health: string; health_detail: string | null }[];
  worksheets: { file_id: string; sheet_id: string; title: string; kind: string; reason: string | null }[];
  mappings: { file_id: string; sheet_id: string; main_module_id: string; module_id: string }[];
  credentials: { id: string; provider: string; account_ref: string; revoked_at: string | null }[];
  mainModules: { id: string; name: string; drive_folder_id: string | null; active: boolean }[];
  reviews: { id: string; kind: string; main_module_id: string | null; title: string; detail: string; candidate_module_id: string | null; created_at: string }[];
  root: { folder_id: string; folder_name: string; account_ref: string | null } | null;
}
interface Run { id: string; version: number; trigger: string; state: string; started_at: string; error_codes: string[] }
interface Impact { source: string; submodulesArchived: string[]; removedFromTotals: { moduleName: string; totalTc: number; openDefects: number }[] }

const PROVIDER_LABEL: Record<string, string> = {
  'google-sheets': 'Google Sheet',
  'google-drive-xlsx': 'Excel in Google Drive',
  'google-drive-folder': 'Google Drive folder',
  onedrive: 'OneDrive workbook',
  'onedrive-folder': 'OneDrive folder',
  upload: 'Uploaded workbook',
};
const HEALTH: Record<string, string> = { healthy: 'text-ok', failing: 'text-bad', missing: 'text-bad', unsupported: 'text-warn', unknown: 'text-ink-3' };

/** Source status, mapping and review queue — administrators only (SRS V1.5 §5.2, FR-GD-006/007). */
export function Sources() {
  const { projectId, project } = useProject();
  const key = useAdminKey();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ['sources', projectId, key], enabled: !!key, queryFn: () => admin<SourcesResp>(`/projects/${projectId}/sources`), refetchInterval: 15_000 });
  const runs = useQuery({ queryKey: ['runs', projectId, key], enabled: !!key, queryFn: () => admin<Run[]>(`/projects/${projectId}/runs`), refetchInterval: 15_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sources', projectId] });
    qc.invalidateQueries({ queryKey: ['runs', projectId] });
  };
  const sync = useMutation({ mutationFn: () => admin(`/projects/${projectId}/sync`, { method: 'POST', json: {} }), onSuccess: refresh });
  const [creating, setCreating] = useState(false);
  const [unlinking, setUnlinking] = useState<SourcesResp['connections'][number] | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: project.name, to: `/projects/${projectId}` }, { label: 'Data sources & review' }]} />
      <PageTitle eyebrow={`${project.name} · Administration`} title="Data sources & review">
        {key && (
          <>
            <Button onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? 'Requesting…' : 'Sync now'}</Button>
            <Button variant="primary" onClick={() => setCreating(true)} disabled={!!project.archived_at}>+ New main module</Button>
          </>
        )}
      </PageTitle>
      {params.get('oauth') === 'connected' && <Notice tone="info" title="Google account connected">Use + Add on a main module to choose Drive sources.</Notice>}
      {params.get('oauth') === 'error' && <Notice tone="bad" title="Account connection failed">{params.get('reason') ?? 'Unknown error'}. Nothing was saved.</Notice>}

      {!key ? (
        <Card className="p-6">
          <h2 className="text-base font-semibold text-ink">Source details are protected</h2>
          <p className="mt-1 mb-5 max-w-2xl text-sm text-ink-2">File names, accounts and mappings are visible only to data-source administrators. Aggregated metrics stay available on the dashboards.</p>
          <AdminKeyInline projectId={projectId} />
        </Card>
      ) : q.isLoading ? (
        <Card className="p-6 text-sm text-ink-3">Loading sources…</Card>
      ) : q.isError ? (
        <Notice tone="bad" title="Could not load sources">{(q.error as Error).message}</Notice>
      ) : (
        <>
          <ReviewQueue projectId={projectId} data={q.data!} onDone={refresh} />
          {q.data!.root && (
            <p className="text-sm text-ink-2">
              Project Drive folder: <strong className="text-ink">{q.data!.root.folder_name}</strong>
              {q.data!.root.account_ref && <> · read-only via {q.data!.root.account_ref}</>}. New subfolders are queued for review, never added automatically.
            </p>
          )}
          {q.data!.mainModules.length === 0 ? (
            <EmptyState title={`No main modules in ${project.name}`} action={<Button variant="primary" onClick={() => setCreating(true)}>+ New main module</Button>}>
              Main modules usually come from the project’s Drive subfolders. You can also add one by name and attach sources to it.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-4">
              {q.data!.mainModules.map((m) => (
                <MainModuleCard key={m.id} projectId={projectId} m={m} data={q.data!} onDone={refresh} onUnlink={setUnlinking} />
              ))}
            </ul>
          )}
          {runs.data && runs.data.length > 0 && <RunsCard projectId={projectId} runs={runs.data} />}
        </>
      )}
      <NewMainModuleDialog open={creating} onClose={() => setCreating(false)} projectId={projectId} onDone={refresh} />
      <UnlinkDialog projectId={projectId} conn={unlinking} onClose={() => setUnlinking(null)} onDone={refresh} />
    </div>
  );
}

function ReviewQueue({ projectId, data, onDone }: { projectId: string; data: SourcesResp; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ id: string; name: string } | null>(null);
  if (data.reviews.length === 0) return null;
  const act = async (id: string, action: string, name?: string) => {
    setBusy(id);
    setErr(null);
    try {
      await admin(`/projects/${projectId}/reviews/${id}`, { method: 'POST', json: { action, name } });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-ink">Needs your confirmation ({data.reviews.length})</h2>
        <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">Quarantined — not counted, not in navigation</span>
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-bad">{err}</p>}
      <ul className="flex flex-col gap-2.5">
        {data.reviews.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn-soft/50 p-3.5">
            <div className="min-w-0 flex-1 basis-80">
              <p className="text-sm font-semibold text-ink">{r.title}</p>
              <p className="text-xs text-ink-2">{r.detail}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {r.kind === 'submodule-name-collision' && (
                <>
                  <Button disabled={busy === r.id} onClick={() => act(r.id, 'same-submodule')}>Same submodule</Button>
                  <Button disabled={busy === r.id} onClick={() => setNaming({ id: r.id, name: `${r.title} (2)` })}>New submodule…</Button>
                </>
              )}
              {r.kind === 'unknown-folder' && <Button variant="primary" disabled={busy === r.id} onClick={() => act(r.id, 'add-main-module', r.title)}>Add as main module</Button>}
              <Button variant="ghost" disabled={busy === r.id} onClick={() => act(r.id, 'ignore')}>Ignore</Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog
        open={!!naming}
        onClose={() => setNaming(null)}
        title="Name the new submodule"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNaming(null)}>Cancel</Button>
            <Button variant="primary" disabled={!naming?.name.trim()} onClick={() => { if (naming) act(naming.id, 'new-submodule', naming.name.trim()); setNaming(null); }}>
              Create submodule
            </Button>
          </>
        }
      >
        <Field label="Submodule name" hint="Must differ from existing submodules in this main module.">
          {(id) => <input id={id} className={inputCls} value={naming?.name ?? ''} onChange={(e) => setNaming((n) => (n ? { ...n, name: e.target.value } : n))} maxLength={120} />}
        </Field>
      </Dialog>
    </Card>
  );
}

function MainModuleCard({ projectId, m, data, onDone, onUnlink }: { projectId: string; m: SourcesResp['mainModules'][number]; data: SourcesResp; onDone: () => void; onUnlink: (c: SourcesResp['connections'][number]) => void }) {
  const conns = data.connections.filter((c) => c.main_module_id === m.id);
  const toggleActive = async () => {
    await admin(`/projects/${projectId}/main-modules/${m.id}`, { method: 'PATCH', json: { active: !m.active } });
    onDone();
  };
  return (
    <li>
      <Card className={`p-5 ${m.active ? '' : 'opacity-70'}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-ink">{m.name}</h2>
            <p className="text-xs text-ink-3">
              Main module <span className="num">{m.id}</span>
              {m.drive_folder_id && ' · from the project’s Drive subfolder'}
              {!m.active && ' · archived (excluded from totals)'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to={`/projects/${projectId}/main/${m.id}/add`} className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-ink hover:bg-primary-hover">+ Add from Google Drive</Link>
            <UploadButton projectId={projectId} mainModuleId={m.id} onDone={onDone} />
            <Button variant="ghost" onClick={toggleActive}>{m.active ? 'Archive' : 'Restore'}</Button>
          </div>
        </div>
        {conns.length === 0 ? (
          <p className="mt-4 rounded-lg bg-surface-2/60 px-3 py-3 text-sm text-ink-3">No sources linked yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Sources linked to {m.name}</caption>
              <thead className="bg-surface-2 text-left text-xs text-ink-3">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Source</th>
                  <th scope="col" className="px-3 py-2 font-medium">Tabs → submodules</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last successful read</th>
                  <th scope="col" className="px-3 py-2 font-medium">Health</th>
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {conns.map((c) => {
                  const docs = data.documents.filter((d) => d.connection_id === c.id);
                  const tabs = docs.flatMap((d) =>
                    data.worksheets.filter((w) => w.file_id === d.file_id).map((w) => {
                      const map = data.mappings.find((x) => x.file_id === w.file_id && x.sheet_id === w.sheet_id);
                      return w.kind === 'module' ? `${w.title}${map ? '' : ' (pending)'}` : w.kind === 'defects' ? `${w.title} (defect register)` : `${w.title} (skipped)`;
                    }),
                  );
                  const worst = docs.find((d) => d.health !== 'healthy') ?? docs[0];
                  return (
                    <tr key={c.id} className="border-t border-line align-top">
                      <td className="px-3 py-2.5">
                        <span className="font-semibold text-ink">{c.display_name}</span>
                        <span className="block text-xs text-ink-3">{PROVIDER_LABEL[c.provider] ?? c.provider}{c.state === 'disabled' ? ' · disabled' : ''}</span>
                      </td>
                      <td className="px-3 py-2.5 text-ink-2">{tabs.length ? tabs.join(', ') : 'After first read'}</td>
                      <td className="px-3 py-2.5 text-ink-2">{dateTime(docs.map((d) => d.last_success_at).filter(Boolean).sort().at(-1) ?? null)}</td>
                      <td className={`px-3 py-2.5 font-semibold ${HEALTH[worst?.health ?? 'unknown']}`} title={worst?.health_detail ?? ''}>
                        {worst?.health ?? 'unknown'}
                        {worst?.health_detail && <span className="block text-xs font-normal text-bad">{worst.health_detail}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button variant="ghost" onClick={() => onUnlink(c)}>Unlink…</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </li>
  );
}

function UploadButton({ projectId, mainModuleId, onDone }: { projectId: string; mainModuleId: string; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="sr-only"
        aria-label="Upload a workbook to this main module"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          const fd = new FormData();
          fd.set('file', f);
          fd.set('confirmProjectId', projectId);
          fd.set('mainModuleId', mainModuleId);
          try {
            await admin(`/projects/${projectId}/sources/upload`, { method: 'POST', body: fd });
            onDone();
          } finally {
            setBusy(false);
            e.target.value = '';
          }
        }}
      />
      <Button onClick={() => ref.current?.click()} disabled={busy}>{busy ? 'Uploading…' : 'Upload workbook'}</Button>
    </>
  );
}

function NewMainModuleDialog({ open, onClose, projectId, onDone }: { open: boolean; onClose: () => void; projectId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New main module"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              setErr(null);
              try {
                await admin(`/projects/${projectId}/main-modules`, { method: 'POST', json: { name: name.trim() } });
                setName('');
                onDone();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <Field label="Main module name" hint="It appears in navigation once it has validated submodules.">{(id) => <input id={id} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
      {err && <p role="alert" className="text-sm text-bad">{err}</p>}
    </Dialog>
  );
}

function UnlinkDialog({ projectId, conn, onClose, onDone }: { projectId: string; conn: SourcesResp['connections'][number] | null; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const impact = useQuery({ queryKey: ['impact', projectId, conn?.id], enabled: !!conn, queryFn: () => admin<Impact>(`/projects/${projectId}/sources/${conn!.id}/impact`) });
  return (
    <Dialog
      open={!!conn}
      onClose={() => (setTyped(''), onClose())}
      title="Unlink data source"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={typed !== projectId}
            onClick={async () => {
              setErr(null);
              try {
                await admin(`/projects/${projectId}/sources/${conn!.id}`, { method: 'DELETE', json: { confirm: projectId } });
                setTyped('');
                onDone();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Unlink source
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-2"><strong className="text-ink">{conn?.display_name}</strong> stops syncing. Original Drive content is not deleted or changed.</p>
      <div className="rounded-xl bg-surface-2/70 p-3 text-sm">
        <p className="font-semibold text-ink">Impact preview</p>
        {impact.isLoading ? (
          <p className="text-ink-3">Calculating…</p>
        ) : impact.data && impact.data.removedFromTotals.length ? (
          <ul className="mt-1 list-disc pl-5 text-ink-2">
            {impact.data.removedFromTotals.map((r) => (
              <li key={r.moduleName}>{r.moduleName}: {r.totalTc} TC and {r.openDefects} open defects leave the totals (submodule archived)</li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3">No submodule depends solely on this source.</p>
        )}
      </div>
      <Field label={`Type the project id “${projectId}” to confirm`}>{(id) => <input id={id} className={`${inputCls} num`} value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
      {err && <p role="alert" className="text-sm text-bad">{err}</p>}
    </Dialog>
  );
}

interface RunDetail {
  validation: { gates: { id: string; name: string; state: string; discrepancies: string[] }[] } | null;
  run: { source_outcomes: { fileName: string; state: string; errorCode?: string; errorMessage?: string }[] };
}

function RunsCard({ projectId, runs }: { projectId: string; runs: Run[] }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['run', projectId, openRun], enabled: !!openRun, queryFn: () => admin<RunDetail>(`/projects/${projectId}/runs/${openRun}`) });
  const meaningful = runs.filter((r) => r.state !== 'No Change').slice(0, 12);
  const tone = (s: string) => (s === 'Validated' ? 'text-ok' : s.includes('Failed') ? 'text-bad' : 'text-ink-2');
  return (
    <Card className="p-5">
      <h2 className="text-[0.95rem] font-semibold text-ink">Synchronization history</h2>
      <p className="mt-0.5 text-xs text-ink-3">Runs without source changes are omitted. Select a run to see its validation evidence.</p>
      <ul className="mt-4 divide-y divide-line">
        {meaningful.map((r) => (
          <li key={r.id}>
            <button className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-left text-sm hover:bg-surface-2/50" aria-expanded={openRun === r.id} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
              <span className="num w-14 text-ink-3">v{r.version}</span>
              <span className={`w-36 font-medium ${tone(r.state)}`}>{r.state}</span>
              <span className="text-ink-2">{dateTime(r.started_at)}</span>
              <span className="text-xs text-ink-3">{r.trigger}</span>
              {r.error_codes.length > 0 && <span className="text-xs text-bad">{[...new Set(r.error_codes)].join(', ')}</span>}
            </button>
            {openRun === r.id && (
              <div className="mb-3 rounded-xl bg-surface-2/60 p-4 text-sm">
                {detail.isLoading && <p className="text-ink-3">Loading evidence…</p>}
                {detail.data?.run.source_outcomes.filter((o) => o.state === 'failed').map((o) => (
                  <p key={o.fileName} className="mb-2 text-bad">{o.fileName}: {o.errorCode} — {o.errorMessage}</p>
                ))}
                {detail.data?.validation?.gates.map((g) => (
                  <div key={g.id} className="mb-2">
                    <span className={`font-medium ${g.state === 'Passed' ? 'text-ok' : g.state === 'Failed' ? 'text-bad' : 'text-ink-2'}`}>{g.id} {g.name}: {g.state}</span>
                    {g.discrepancies.length > 0 && (
                      <ul className="mt-1 ml-4 list-disc text-xs text-ink-2">
                        {g.discrepancies.slice(0, 20).map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
