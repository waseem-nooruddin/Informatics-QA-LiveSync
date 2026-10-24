import { useSyncExternalStore } from 'react';
import { ANON_KEY, SUPABASE_URL } from './supabase';

// No login page (SEC-001). Admin actions carry an admin key entered once in Settings and kept
// for this browser tab only. The server verifies it on every request (SEC-003).
const KEY = 'qals.adminKey';
const listeners = new Set<() => void>();

function read(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminKey(v: string) {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: key lives only for this call chain */
  }
  listeners.forEach((l) => l());
}

export function useAdminKey(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => '',
  );
}

export class AdminError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function admin<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-admin-key', read());
  headers.set('apikey', ANON_KEY);
  headers.set('authorization', `Bearer ${ANON_KEY}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-api${path}`, { ...init, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new AdminError(res.status, data?.error ?? 'ERROR', data?.message ?? `Request failed (${res.status})`);
  return data as T;
}
