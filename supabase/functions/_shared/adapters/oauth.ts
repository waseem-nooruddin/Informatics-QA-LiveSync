import { db } from '../db.ts';
import { redact } from '../http.ts';
import { SourceError } from './types.ts';

export interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  tenant?: string;
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];
export const MICROSOFT_SCOPES = ['offline_access', 'Files.Read.All', 'User.Read'];

export function tokenEndpoint(provider: 'google' | 'microsoft', tenant = 'common'): string {
  return provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export function clientCreds(provider: 'google' | 'microsoft'): { id: string; secret: string } {
  const p = provider === 'google' ? 'GOOGLE' : 'MICROSOFT';
  const id = Deno.env.get(`${p}_CLIENT_ID`);
  const secret = Deno.env.get(`${p}_CLIENT_SECRET`);
  if (!id || !secret) throw new SourceError('CREDENTIAL_MISSING', `${provider} OAuth client is not configured`);
  return { id, secret };
}

/**
 * Return a valid access token, refreshing and re-encrypting it in Vault when near expiry.
 * projectId null = a platform-level credential (used before a project exists).
 */
export async function accessToken(projectId: string | null, credentialId: string | null, provider: 'google' | 'microsoft'): Promise<string> {
  return (await accessTokenWithExpiry(projectId, credentialId, provider)).token;
}

export async function accessTokenWithExpiry(
  projectId: string | null,
  credentialId: string | null,
  provider: 'google' | 'microsoft',
): Promise<{ token: string; expiresAt: number }> {
  if (!credentialId) throw new SourceError('CREDENTIAL_MISSING', 'Source has no connected account');
  const { data, error } = await db().rpc('read_credential', { p_project: projectId, p_id: credentialId });
  if (error || !data) throw new SourceError('CREDENTIAL_MISSING', 'Credential not found or revoked');
  const tok = data as StoredToken;
  if (tok.expires_at - Date.now() > 120_000) return { token: tok.access_token, expiresAt: tok.expires_at };

  const { id, secret } = clientCreds(provider);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: id, client_secret: secret });
  if (provider === 'microsoft') body.set('scope', MICROSOFT_SCOPES.join(' '));
  const res = await fetch(tokenEndpoint(provider, tok.tenant), { method: 'POST', body });
  if (!res.ok) {
    console.error(JSON.stringify({ level: 'warn', msg: 'token refresh failed', detail: redact(await res.text()) }));
    throw new SourceError('TOKEN_REFRESH_FAILED', 'Access was revoked or expired; reconnect the account');
  }
  const j = await res.json();
  const next: StoredToken = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? tok.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
    tenant: tok.tenant,
  };
  await db().rpc('update_credential', { p_project: projectId, p_id: credentialId, p_secret: next });
  return { token: next.access_token, expiresAt: next.expires_at };
}
