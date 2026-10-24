import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminKeyInline } from '../components/AdminKey';
import { useProject } from '../components/ProjectLayout';
import { Button, Card, Dialog, Field, inputCls, Notice, PageTitle } from '../components/ui';
import { admin, useAdminKey } from '../lib/admin';
import { dateTime } from '../lib/format';

interface RulesetResp {
  active: string;
  versions: { version: string; ruleset: Record<string, unknown>; provisional: boolean; approved_by: string | null; approved_at: string | null; created_at: string }[];
}

/** Project administration (MP-06): rename, archive/restore, freshness, versioned rules. */
export function Settings() {
  const { projectId, project } = useProject();
  const key = useAdminKey();
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageTitle eyebrow={`${project.name} · Settings`} title="Project settings" />
      <AdminKeyInline projectId={projectId} />
      {key && (
        <>
          <RenameCard />
          <FreshnessCard />
          <RulesetCard />
          <ArchiveCard />
        </>
      )}
    </div>
  );
}

function RenameCard() {
  const { projectId, project } = useProject();
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const m = useMutation({ mutationFn: () => admin(`/projects/${projectId}`, { method: 'PATCH', json: { name } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['directory'] }) });
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-ink">Display name</h2>
      <p className="mt-0.5 mb-4 text-sm text-ink-3">
        The project identifier <span className="num font-medium text-ink-2">{projectId}</span> is permanent and never changes.
      </p>
      <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <input aria-label="Display name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <Button type="submit" disabled={!name.trim() || name === project.name || m.isPending}>
          Save
        </Button>
      </form>
      {m.isError && <p className="mt-2 text-sm text-bad">{(m.error as Error).message}</p>}
      {m.isSuccess && <p className="mt-2 text-sm text-ok">Renamed. Audit history kept.</p>}
    </Card>
  );
}

function FreshnessCard() {
  const { projectId, project } = useProject();
  const qc = useQueryClient();
  const [mins, setMins] = useState(String(project.stale_threshold_minutes));
  const m = useMutation({ mutationFn: () => admin(`/projects/${projectId}/settings`, { method: 'PUT', json: { staleThresholdMinutes: Number(mins) } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['directory'] }) });
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-ink">Freshness threshold</h2>
      <p className="mt-0.5 mb-4 text-sm text-ink-3">The data is marked stale when the last verified snapshot is older than this. The scheduler targets a sync every 3 minutes, but that is not a guaranteed maximum delay.</p>
      <form className="flex items-end gap-2" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
        <Field label="Minutes">{(id) => <input id={id} type="number" min={1} max={1440} className={`${inputCls} num w-32`} value={mins} onChange={(e) => setMins(e.target.value)} />}</Field>
        <Button type="submit" disabled={m.isPending}>
          Save
        </Button>
      </form>
      {m.isError && <p className="mt-2 text-sm text-bad">{(m.error as Error).message}</p>}
    </Card>
  );
}

const DSI_EXAMPLE = JSON.stringify({ dsi: { version: 'dsi-1', weights: { Critical: 10, High: 5, Medium: 3, Low: 1 }, population: 'open', denominator: 'none', missingSeverity: 'fail', decimals: 2 } }, null, 2);

function RulesetCard() {
  const { projectId } = useProject();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ruleset', projectId], queryFn: () => admin<RulesetResp>(`/projects/${projectId}/ruleset`) });
  const [version, setVersion] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => admin(`/projects/${projectId}/ruleset`, { method: 'PUT', json: { version, approvedBy, ruleset: JSON.parse(text || '{}') } }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['ruleset', projectId] }), setVersion(''), setText('')),
    onError: (e) => setErr((e as Error).message),
  });
  const active = q.data?.versions.find((v) => v.version === q.data?.active);
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-ink">Business rules</h2>
      <p className="mt-0.5 mb-4 text-sm text-ink-3">
        Versioned per project: status mappings, defect populations, source precedence and the DSI formula. A new version triggers revalidation. Overrides are merged onto the platform defaults.
      </p>
      {active && (
        <div className="mb-4 rounded-xl bg-surface-2/60 px-4 py-3 text-sm">
          Active: <span className="num font-semibold">{active.version}</span>{' '}
          {active.provisional ? <span className="text-warn">· provisional (not signed off)</span> : <span className="text-ok">· approved by {active.approved_by} on {dateTime(active.approved_at)}</span>}
        </div>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          try {
            JSON.parse(text || '{}');
          } catch {
            setErr('Ruleset must be valid JSON');
            return;
          }
          m.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New version label">{(id) => <input id={id} className={`${inputCls} num`} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1" />}</Field>
          <Field label="Approved by" hint="Leave empty to keep it provisional">{(id) => <input id={id} className={inputCls} value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} placeholder="QA owner name" />}</Field>
        </div>
        <Field label="Ruleset overrides (JSON)" hint="Example: enabling an approved DSI formula">
          {(id) => <textarea id={id} rows={9} className={`${inputCls} num h-auto py-2 text-xs`} value={text} onChange={(e) => setText(e.target.value)} placeholder={DSI_EXAMPLE} />}
        </Field>
        {err && <p role="alert" className="text-sm text-bad">{err}</p>}
        <div>
          <Button type="submit" variant="primary" disabled={!version || m.isPending}>
            Activate version
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ArchiveCard() {
  const { projectId, project } = useProject();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const archived = !!project.archived_at;
  const m = useMutation({
    mutationFn: () => admin(`/projects/${projectId}/${archived ? 'restore' : 'archive'}`, { method: 'POST', json: { confirm: typed } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['directory'] });
      setOpen(false);
      if (!archived) nav('/projects');
    },
  });
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-ink">{archived ? 'Restore project' : 'Archive project'}</h2>
      <p className="mt-0.5 mb-4 text-sm text-ink-3">
        {archived ? 'Resume synchronization and show the project in navigation again.' : 'Stops synchronization and hides the project from navigation. Snapshots, records and audit history are retained.'}
      </p>
      <Button variant={archived ? 'secondary' : 'danger'} onClick={() => setOpen(true)}>
        {archived ? 'Restore…' : 'Archive…'}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={archived ? `Restore ${project.name}` : `Archive ${project.name}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={archived ? 'primary' : 'danger'} disabled={typed !== projectId || m.isPending} onClick={() => m.mutate()}>
              Confirm
            </Button>
          </>
        }
      >
        <Field label={`Type “${projectId}” to confirm`}>{(id) => <input id={id} className={`${inputCls} num`} value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
        {m.isError && <Notice tone="bad" title="Failed">{(m.error as Error).message}</Notice>}
      </Dialog>
    </Card>
  );
}
