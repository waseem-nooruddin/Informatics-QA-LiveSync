import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { admin, AdminError, useAdminKey } from '../lib/admin';
import { openDrivePicker, type PickerConfig } from '../lib/drivePicker';
import { AdminKeyInline } from './AdminKey';
import { Button, Dialog, Field, inputCls } from './ui';

type Step = 'start' | 'link' | 'loading' | 'preview' | 'working' | 'done' | 'cancelled' | 'error';

interface ErrState {
  title: string;
  message: string;
  canConnect?: boolean;
  canLink?: boolean;
}

function explain(e: unknown, fallback: string): ErrState {
  if (e instanceof AdminError) {
    if (e.code === 'GOOGLE_ACCOUNT_REQUIRED') return { title: 'Connect a Google account first', message: 'A Google account with read-only Drive access must be connected before folders can be chosen.', canConnect: true };
    if (e.code === 'PICKER_NOT_CONFIGURED') return { title: 'Google Drive Picker unavailable', message: `${e.message}. You can paste a Drive link instead.`, canLink: true };
    if (e.code === 'ACCESS_DENIED' || e.status === 403) return { title: 'Permission denied', message: 'This account cannot read the selected item, or your organization blocks access. Ask the owner for read access, or use another link.', canLink: true };
    if (e.code === 'NOT_FOUND' || e.status === 404) return { title: 'Not found', message: 'The item was moved, deleted, or the link is wrong.', canLink: true };
    return { title: fallback, message: e.message, canLink: true };
  }
  return { title: fallback, message: (e as Error).message, canLink: true };
}

async function connectGoogle(projectId?: string) {
  const r = await admin<{ url: string }>(`/oauth/start?provider=google${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`);
  window.location.assign(r.url);
}

function ErrorPanel({ err, onLink, projectId }: { err: ErrState; onLink: () => void; projectId?: string }) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl bg-bad-soft p-4 text-sm text-bad">
      <strong>{err.title}</strong>
      <span className="text-ink-2">{err.message}</span>
      <div className="flex flex-wrap gap-2">
        {err.canConnect && (
          <Button variant="primary" onClick={() => connectGoogle(projectId).catch(() => undefined)}>
            Connect Google account
          </Button>
        )}
        {err.canLink && <Button onClick={onLink}>Paste a Drive link instead</Button>}
      </div>
    </div>
  );
}

interface FolderPreview {
  folder: { id: string; name: string };
  account: string;
  proposedName: string;
  proposedId: string;
  mainModules: { folderId: string; name: string; workbooks: number; submodules: string[]; supported: boolean; alreadyLinked: boolean }[];
  conflicts: string[];
}

/** + Add New Project → Google Drive folder selection → preview → YES/NO (FR-GD-001/002). */
export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const key = useAdminKey();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [step, setStep] = useState<Step>('start');
  const [err, setErr] = useState<ErrState | null>(null);
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<FolderPreview | null>(null);
  const [name, setName] = useState('');
  const [pid, setPid] = useState('');
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [created, setCreated] = useState<string | null>(null);

  const reset = () => {
    setStep('start');
    setErr(null);
    setLink('');
    setPreview(null);
    setCreated(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  async function loadPreview(folder: string) {
    setStep('loading');
    setErr(null);
    try {
      const p = await admin<FolderPreview>('/projects/preview-from-folder', { method: 'POST', json: { folderId: folder } });
      setPreview(p);
      setName(p.proposedName);
      setPid(p.proposedId);
      setChosen(Object.fromEntries(p.mainModules.map((m) => [m.folderId, m.supported && !m.alreadyLinked])));
      setStep('preview');
    } catch (e) {
      setErr(explain(e, 'Could not read the folder'));
      setStep('error');
    }
  }

  async function pick() {
    setErr(null);
    try {
      const cfg = await admin<PickerConfig>('/picker-config');
      const picked = await openDrivePicker(cfg, 'folder');
      if (!picked?.length) return setStep('cancelled');
      await loadPreview(picked[0]!.id);
    } catch (e) {
      setErr(explain(e, 'The Google Drive Picker could not open'));
      setStep('error');
    }
  }

  async function create() {
    if (!preview) return;
    setStep('working');
    try {
      const mainModules = preview.mainModules.filter((m) => chosen[m.folderId]).map((m) => ({ folderId: m.folderId, name: m.name }));
      await admin('/projects/from-folder', { method: 'POST', json: { confirm: 'YES', folderId: preview.folder.id, name: name.trim(), id: pid.trim(), mainModules } });
      await qc.invalidateQueries({ queryKey: ['directory'] });
      setCreated(pid.trim());
      setStep('done');
    } catch (e) {
      setErr(explain(e, 'The project was not created'));
      setStep('preview');
    }
  }

  const idValid = /^[a-z0-9][a-z0-9-]{1,39}$/.test(pid) && name.trim().length > 0;

  return (
    <Dialog open={open} onClose={close} title="+ Add New Project">
      {!key ? (
        <AdminKeyInline />
      ) : step === 'start' ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-ink-2">Choose the project’s Google Drive folder. Its subfolders are proposed as main modules, and you confirm everything before anything is created. Drive content is never moved, renamed or edited.</p>
          <Button variant="primary" className="h-11 self-start" onClick={pick}>
            Open Google Drive folder picker
          </Button>
          <button className="self-start text-sm text-accent underline underline-offset-4" onClick={() => setStep('link')}>
            Picker blocked? Paste a folder link or ID instead
          </button>
        </div>
      ) : step === 'link' ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), loadPreview(link))}>
          <Field label="Google Drive folder link or ID" hint="The server checks access before showing the same preview and YES/NO confirmation.">
            {(id) => <input id={id} className={inputCls} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" />}
          </Field>
          <div className="flex gap-2">
            <Button variant="ghost" type="button" onClick={() => setStep('start')}>
              Back
            </Button>
            <Button variant="primary" type="submit" disabled={link.trim().length < 10}>
              Check folder
            </Button>
          </div>
        </form>
      ) : step === 'loading' || step === 'working' ? (
        <p role="status" className="py-6 text-center text-sm text-ink-2">
          {step === 'loading' ? 'Reading the folder (read-only)…' : 'Creating the project…'}
        </p>
      ) : step === 'error' && err ? (
        <ErrorPanel err={err} onLink={() => setStep('link')} />
      ) : step === 'cancelled' ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-semibold text-ink">Cancelled — nothing was changed.</p>
          <Button className="self-start" onClick={reset}>
            Start again
          </Button>
        </div>
      ) : step === 'done' && created ? (
        <div className="flex flex-col gap-3">
          <p className="text-base font-bold text-ok">✓ Project created</p>
          <p className="text-sm text-ink-2">The first synchronization and validation are running. Navigation and charts appear once all five checks pass.</p>
          <Button variant="primary" className="self-start" onClick={() => (close(), nav(`/projects/${created}`))}>
            Open project
          </Button>
        </div>
      ) : step === 'preview' && preview ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-ink-3">Drive folder</dt>
              <dd className="font-semibold text-ink">{preview.folder.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Source account</dt>
              <dd className="font-semibold text-ink">{preview.account}</dd>
            </div>
          </dl>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project display name">{(id) => <input id={id} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
            <Field label="Project ID (permanent)">{(id) => <input id={id} className={`${inputCls} num`} value={pid} onChange={(e) => setPid(e.target.value.toLowerCase())} maxLength={40} />}</Field>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-semibold text-ink">Discovered main modules (subfolders)</legend>
            {preview.mainModules.length === 0 && <p className="text-sm text-ink-3">No subfolders found. The project will start empty until main modules are added.</p>}
            {preview.mainModules.map((m) => (
              <label key={m.folderId} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${m.supported && !m.alreadyLinked ? 'border-line' : 'border-warn/40 bg-warn-soft'}`}>
                <input type="checkbox" className="mt-0.5 size-4" checked={!!chosen[m.folderId]} disabled={m.alreadyLinked} onChange={(e) => setChosen((c) => ({ ...c, [m.folderId]: e.target.checked }))} />
                <span className="flex-1">
                  <span className="font-semibold text-ink">{m.name}</span>
                  <span className="block text-xs text-ink-3">
                    {m.alreadyLinked ? 'Already linked to another project — not added' : m.supported ? `${m.workbooks} workbook(s) · ${m.submodules.length} valid tab(s)${m.submodules.length ? `: ${m.submodules.slice(0, 5).join(', ')}` : ''}` : 'No supported documents — skipped unless ticked'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {preview.conflicts.length > 0 && (
            <div role="status" className="rounded-lg bg-warn-soft px-3 py-2.5 text-sm text-warn">
              <strong>{preview.conflicts.length} conflict(s):</strong>
              <ul className="mt-1 list-disc pl-5">
                {preview.conflicts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {err && <ErrorPanel err={err} onLink={() => setStep('link')} />}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-sm font-semibold text-ink">Create this project from the selected Google Drive folder?</span>
            <div className="flex gap-2">
              <Button onClick={() => setStep('cancelled')}>NO</Button>
              <Button variant="primary" disabled={!idValid} onClick={create}>
                YES, create project
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

interface SourcesPreview {
  project: string;
  mainModule: string;
  items: { id: string; name: string; kind: string; result: 'add' | 'skip'; note: string; detected: string[] }[];
}

/** Main module + Add → Google Drive Picker → preview → YES/NO, attached only here (FR-GD-003/004). */
export function AddSourcesDialog({ open, onClose, projectId, projectName, mainModuleId, mainModuleName }: { open: boolean; onClose: () => void; projectId: string; projectName: string; mainModuleId: string; mainModuleName: string }) {
  const key = useAdminKey();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('start');
  const [err, setErr] = useState<ErrState | null>(null);
  const [links, setLinks] = useState('');
  const [preview, setPreview] = useState<SourcesPreview | null>(null);
  const [result, setResult] = useState<{ added: string[]; skipped: { id: string; reason: string }[] } | null>(null);

  const close = () => {
    setStep('start');
    setErr(null);
    setPreview(null);
    setResult(null);
    setLinks('');
    onClose();
  };

  async function loadPreview(items: string[]) {
    setStep('loading');
    try {
      const p = await admin<SourcesPreview>(`/projects/${projectId}/main-modules/${mainModuleId}/sources/preview`, { method: 'POST', json: { items } });
      setPreview(p);
      setStep('preview');
    } catch (e) {
      setErr(explain(e, 'Could not inspect the selection'));
      setStep('error');
    }
  }

  async function pick() {
    try {
      const cfg = await admin<PickerConfig>(`/picker-config?projectId=${encodeURIComponent(projectId)}`);
      const picked = await openDrivePicker(cfg, 'sources');
      if (!picked?.length) return setStep('cancelled');
      await loadPreview(picked.map((p) => p.id));
    } catch (e) {
      setErr(explain(e, 'The Google Drive Picker could not open'));
      setStep('error');
    }
  }

  async function confirm() {
    if (!preview) return;
    setStep('working');
    try {
      const items = preview.items.filter((i) => i.result === 'add').map((i) => i.id);
      const r = await admin<{ added: string[]; skipped: { id: string; reason: string }[] }>(`/projects/${projectId}/main-modules/${mainModuleId}/sources`, {
        method: 'POST',
        json: { confirm: 'YES', confirmProjectId: projectId, confirmMainModuleId: mainModuleId, items },
      });
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['sources', projectId] });
      setStep('done');
    } catch (e) {
      setErr(explain(e, 'Sources were not added'));
      setStep('error');
    }
  }

  const addable = preview?.items.filter((i) => i.result === 'add').length ?? 0;

  return (
    <Dialog open={open} onClose={close} title="Add from Google Drive">
      <div className="-mx-6 -mt-5 mb-1 bg-navy px-6 py-3.5 text-navy-ink">
        <div className="text-[11px] font-semibold tracking-[0.1em] text-navy-ink-2 uppercase">Adding to</div>
        <div className="text-base font-bold">
          {projectName} <span className="text-sky">→</span> {mainModuleName}
        </div>
      </div>
      {!key ? (
        <AdminKeyInline projectId={projectId} />
      ) : step === 'start' ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-ink-2">Select one or more Google Sheets, Excel files or folders. They are linked only to {mainModuleName}; nothing in Drive is changed.</p>
          <Button variant="primary" className="h-11 self-start" onClick={pick}>
            Open Google Drive Picker
          </Button>
          <button className="self-start text-sm text-accent underline underline-offset-4" onClick={() => setStep('link')}>
            Picker blocked? Paste Drive links instead
          </button>
        </div>
      ) : step === 'link' ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), loadPreview(links.split(/\s+/).filter(Boolean)))}>
          <Field label="Google Drive file or folder links (one per line)">
            {(id) => <textarea id={id} rows={4} className={`${inputCls} h-auto py-2`} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />}
          </Field>
          <div className="flex gap-2">
            <Button variant="ghost" type="button" onClick={() => setStep('start')}>
              Back
            </Button>
            <Button variant="primary" type="submit" disabled={!links.trim()}>
              Check items
            </Button>
          </div>
        </form>
      ) : step === 'loading' || step === 'working' ? (
        <p role="status" className="py-6 text-center text-sm text-ink-2">
          {step === 'loading' ? 'Inspecting the selection (read-only)…' : 'Linking sources…'}
        </p>
      ) : step === 'error' && err ? (
        <ErrorPanel err={err} onLink={() => setStep('link')} projectId={projectId} />
      ) : step === 'cancelled' ? (
        <p className="text-sm font-semibold text-ink">Cancelled — nothing was changed.</p>
      ) : step === 'done' && result ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-base font-bold text-ok">✓ {result.added.length} source(s) linked to {mainModuleName}</p>
          {result.skipped.length > 0 && <p className="text-ink-2">{result.skipped.length} skipped (already linked, unsupported or not accessible).</p>}
          <p className="text-ink-3">Synchronization and validation started. New submodules appear after their mapping is confirmed and all checks pass.</p>
        </div>
      ) : step === 'preview' && preview ? (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">Selected Google Drive items</caption>
              <thead className="bg-surface-2 text-left text-xs text-ink-3">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Item</th>
                  <th scope="col" className="px-3 py-2 font-medium">Detected submodules</th>
                  <th scope="col" className="px-3 py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((i) => (
                  <tr key={i.id} className={`border-t border-line ${i.result === 'skip' ? 'bg-warn-soft/60' : ''}`}>
                    <td className="px-3 py-2 font-medium text-ink">
                      {i.name} <span className="text-xs font-normal text-ink-3">· {i.kind}</span>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{i.detected.length ? i.detected.join(', ') : '—'}</td>
                    <td className={`px-3 py-2 text-xs font-semibold ${i.result === 'add' ? 'text-ok' : 'text-warn'}`}>{i.result === 'add' ? '✓ Will be added' : `⚠ ${i.note}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <span className="text-sm font-semibold text-ink">
              Add these Google Drive sources to {projectName} → {mainModuleName}?
            </span>
            <div className="flex gap-2">
              <Button onClick={() => setStep('cancelled')}>NO</Button>
              <Button variant="primary" disabled={addable === 0} onClick={confirm}>
                YES, add {addable}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
