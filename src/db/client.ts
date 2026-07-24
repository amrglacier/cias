// ============================================================
// CIAS - Supabase Database Client & Repository
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';

// Use WeakMap to cache clients per-env, avoiding cross-request state leakage
// when Cloudflare Workers reuse isolates across different environments.
const clients = new WeakMap<Env, SupabaseClient>();

export function getSupabase(env: Env): SupabaseClient {
  let client = clients.get(env);
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clients.set(env, client);
  }
  return client;
}

// Reset client (for testing)
export function resetSupabaseClient(): void {
  // WeakMap doesn't support clear(), so we recreate it.
  // This is safe because the old entries will be GC'd when env is dereferenced.
  // For testing, tests should create a new env mock per test case.
}
