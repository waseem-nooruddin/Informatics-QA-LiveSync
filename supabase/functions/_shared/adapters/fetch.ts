import { SourceError } from './types.ts';

/** Bounded retry with exponential backoff, honouring Retry-After (FR-SYNC-012). */
export async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (res.status !== 429 && res.status < 500) return res;
      const ra = Number(res.headers.get('retry-after'));
      await res.body?.cancel();
      lastErr = new SourceError(res.status === 429 ? 'RATE_LIMITED' : 'NETWORK', `HTTP ${res.status}`);
      if (i < attempts - 1) await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20_000) : backoff(i));
    } catch (e) {
      lastErr = e instanceof SourceError ? e : new SourceError('NETWORK', (e as Error).message);
      if (i < attempts - 1) await sleep(backoff(i));
    }
  }
  throw lastErr;
}

const backoff = (i: number) => Math.min(500 * 2 ** i, 8000) + Math.floor(Math.random() * 250);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function classifyHttp(res: Response, what: string): never {
  if (res.status === 401 || res.status === 403) throw new SourceError('ACCESS_DENIED', `${what}: access denied (${res.status})`);
  if (res.status === 404) throw new SourceError('NOT_FOUND', `${what}: not found or moved`);
  throw new SourceError('NETWORK', `${what}: HTTP ${res.status}`);
}
