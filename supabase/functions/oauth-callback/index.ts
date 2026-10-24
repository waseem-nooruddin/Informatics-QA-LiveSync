// OAuth redirect target: exchanges the code, stores tokens encrypted in Vault,
// then returns the browser to the project's Data Sources page.
import { clientCreds, GOOGLE_SCOPES, MICROSOFT_SCOPES, tokenEndpoint, type StoredToken } from '../_shared/adapters/oauth.ts';
import { db } from '../_shared/db.ts';
import { redact } from '../_shared/http.ts';
import { verifyState } from '../_shared/state.ts';

const APP_URL = (Deno.env.get('APP_URL') ?? 'http://localhost:5180').replace(/\/$/, '');

const back = (projectId: string | null, params: Record<string, string>) =>
  Response.redirect(`${APP_URL}${projectId ? `/projects/${projectId}/sources` : '/projects'}?${new URLSearchParams(params)}`, 302);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = await verifyState<{ p: string | null; pr: 'google' | 'microsoft' }>(url.searchParams.get('state') ?? '').catch(() => null);
  if (!state) return back(null, { oauth: 'error', reason: 'invalid_state' });
  if (url.searchParams.get('error')) return back(state.p, { oauth: 'error', reason: url.searchParams.get('error')! });
  const code = url.searchParams.get('code');
  if (!code) return back(state.p, { oauth: 'error', reason: 'missing_code' });

  try {
    const { id, secret } = clientCreds(state.pr);
    const tenant = Deno.env.get('MICROSOFT_TENANT') ?? 'common';
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: id, client_secret: secret,
      redirect_uri: `${Deno.env.get('SUPABASE_URL')}/functions/v1/oauth-callback`,
    });
    if (state.pr === 'microsoft') form.set('scope', MICROSOFT_SCOPES.join(' '));
    const res = await fetch(tokenEndpoint(state.pr, tenant), { method: 'POST', body: form });
    if (!res.ok) {
      console.error(JSON.stringify({ msg: 'oauth.exchange_failed', detail: redact(await res.text()) }));
      return back(state.p, { oauth: 'error', reason: 'exchange_failed' });
    }
    const t = await res.json();
    if (!t.refresh_token) return back(state.p, { oauth: 'error', reason: 'no_refresh_token' });

    const who = state.pr === 'google'
      ? await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json()).then((j) => j.email as string)
      : await fetch('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail', { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json()).then((j) => (j.mail ?? j.userPrincipalName) as string);

    const secretJson: StoredToken = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000, tenant };
    const { data: credId, error } = await db().rpc('store_credential', {
      p_project: state.p, p_provider: state.pr, p_account: who ?? 'unknown', p_secret: secretJson,
      p_scopes: state.pr === 'google' ? GOOGLE_SCOPES : MICROSOFT_SCOPES,
    });
    if (error) throw new Error(error.message);
    return back(state.p, { oauth: 'connected', credentialId: String(credId) });
  } catch (e) {
    console.error(JSON.stringify({ msg: 'oauth.error', detail: redact(String((e as Error).message)) }));
    return back(state.p, { oauth: 'error', reason: 'server_error' });
  }
});
