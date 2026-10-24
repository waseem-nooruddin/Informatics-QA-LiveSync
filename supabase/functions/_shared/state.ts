// HMAC-signed OAuth state (CSRF protection for the account-connection flow).

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function key(): Promise<CryptoKey> {
  const secret = Deno.env.get('OAUTH_STATE_SECRET') ?? Deno.env.get('WORKER_SECRET');
  if (!secret) throw new Error('OAUTH_STATE_SECRET not configured');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signState(payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, n: crypto.randomUUID() })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verifyState<T>(state: string): Promise<T | null> {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await key(), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  return payload.exp > Date.now() ? (payload as T) : null;
}
