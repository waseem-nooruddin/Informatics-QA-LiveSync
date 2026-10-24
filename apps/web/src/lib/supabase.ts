import { createClient } from '@supabase/supabase-js';

// Browser-safe anon key only. Anon can read curated aggregate views — nothing else (Option A).
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(SUPABASE_URL && ANON);

export const supabase = createClient(SUPABASE_URL ?? 'http://127.0.0.1:54321', ANON ?? 'missing-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

export const ANON_KEY = ANON ?? '';
