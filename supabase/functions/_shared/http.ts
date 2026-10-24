// Shared HTTP helpers: CORS, security headers, typed errors, secret checks.

const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5180').split(',').map((s) => s.trim());

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0]!,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-admin-key, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Wrap a handler with CORS preflight and redacted error responses (FR-AUD-006). */
export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.code, message: e.message }, e.status);
      const pgMsg = (e as { message?: string })?.message ?? '';
      // Domain errors raised by RPCs arrive wrapped ("create project: PROJECT_EXISTS: …").
      const known = /\b(PROJECT_EXISTS|SOURCE_IN_OTHER_PROJECT|STALE_RUN|NOT_VALIDATED|CREDENTIAL_NOT_FOUND)\b:?\s*(.*)/.exec(pgMsg);
      if (known) return json(req, { error: known[1], message: known[2] || known[1] }, 409);
      console.error(JSON.stringify({ level: 'error', msg: redact(String(pgMsg || e)) }));
      return json(req, { error: 'INTERNAL', message: 'Internal error' }, 500);
    }
  });
}

export function redact(s: string): string {
  return s
    .replace(/(access_token|refresh_token|client_secret|code)=([^&\s"]+)/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/"(access_token|refresh_token|client_secret)"\s*:\s*"[^"]*"/g, '"$1":"[redacted]"');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i]! ^ y[i]!;
  return r === 0;
}

export function requireWorkerSecret(req: Request): void {
  const expected = Deno.env.get('WORKER_SECRET');
  const got = req.headers.get('x-worker-secret') ?? '';
  if (!expected || !timingSafeEqual(got, expected)) throw new HttpError(401, 'UNAUTHORIZED', 'Worker secret required');
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const MODULE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function assertProjectId(id: string | undefined): string {
  if (!id || !PROJECT_ID_RE.test(id)) throw new HttpError(400, 'INVALID_PROJECT_ID', 'Project id must be 2–40 chars: a–z, 0–9, hyphen');
  return id;
}
