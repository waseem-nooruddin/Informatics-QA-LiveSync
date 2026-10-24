import { useState } from 'react';
import { admin, setAdminKey, useAdminKey } from '../lib/admin';
import { Button, inputCls } from './ui';

/**
 * Admin key entry — not a login page (SEC-001). The key unlocks administrative actions for
 * this browser tab only and is verified by the server on every call (SEC-003).
 */
export function AdminKeyInline({ projectId }: { projectId?: string }) {
  const current = useAdminKey();
  const [v, setV] = useState('');
  const [state, setState] = useState<{ ok?: string; err?: string; busy?: boolean }>({});

  if (current) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ok-soft px-4 py-3 text-sm text-ok">
        <span>Administrative actions are enabled for this tab{state.ok ? ` (${state.ok})` : ''}.</span>
        <Button variant="ghost" onClick={() => setAdminKey('')}>
          Forget key
        </Button>
      </div>
    );
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setState({ busy: true });
    setAdminKey(v.trim());
    try {
      const who = await admin<{ label: string; scope: string }>(`/whoami${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
      setState({ ok: `${who.label}, ${who.scope === 'platform' ? 'all projects' : who.scope}` });
      setV('');
    } catch (err) {
      setAdminKey('');
      setState({ err: (err as Error).message });
    }
  }

  return (
    <form onSubmit={verify} className="rounded-xl border border-line bg-surface-2/50 p-4">
      <label htmlFor="admin-key" className="text-sm font-medium text-ink">
        Admin key
      </label>
      <p className="mt-0.5 mb-3 text-xs text-ink-3">Needed to manage projects and data sources. Kept only for this browser tab.</p>
      <div className="flex gap-2">
        <input id="admin-key" type="password" autoComplete="off" className={inputCls} value={v} onChange={(e) => setV(e.target.value)} placeholder="Paste admin key" />
        <Button type="submit" variant="primary" disabled={v.trim().length < 16 || state.busy}>
          {state.busy ? 'Checking…' : 'Unlock'}
        </Button>
      </div>
      {state.err && (
        <p role="alert" className="mt-2 text-xs text-bad">
          {state.err}
        </p>
      )}
    </form>
  );
}
