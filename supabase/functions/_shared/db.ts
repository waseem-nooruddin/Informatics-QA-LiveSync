import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { HttpError, sha256Hex } from './http.ts';

let client: SupabaseClient | null = null;

/** Service-role client. Never leaves the server; RLS is bypassed, so every query scopes project_id explicitly. */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Unwrap a Supabase result or throw. Rows are untyped (no generated types), so callers pick T. */
// deno-lint-ignore no-explicit-any
export function must<T = any>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

export interface AdminContext {
  keyId: string;
  label: string;
  scope: string;
}

/** Backend-enforced admin authorization (SEC-003, AT-013). Key is hashed; never stored in clear. */
export async function requireAdmin(req: Request, projectId?: string): Promise<AdminContext> {
  const key = req.headers.get('x-admin-key') ?? '';
  if (key.length < 16) throw new HttpError(401, 'ADMIN_KEY_REQUIRED', 'A valid admin key is required');
  const hash = await sha256Hex(key);
  const { data } = await db().from('admin_keys').select('id,label,scope').eq('key_hash', hash).is('revoked_at', null).maybeSingle();
  if (!data) throw new HttpError(401, 'ADMIN_KEY_INVALID', 'Admin key not recognised');
  if (data.scope !== 'platform' && projectId && data.scope !== projectId) {
    throw new HttpError(403, 'FORBIDDEN_PROJECT', 'Admin key is not authorised for this project');
  }
  if (data.scope !== 'platform' && !projectId) throw new HttpError(403, 'PLATFORM_ADMIN_REQUIRED', 'Platform admin key required');
  return { keyId: data.id, label: data.label, scope: data.scope };
}

export async function audit(projectId: string | null, actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
  await db().from('audit_log').insert({ project_id: projectId, actor, action, detail });
}
