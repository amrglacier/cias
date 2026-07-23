// ============================================================
// CIAS - Supabase Database Client & Repository
// ============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';

let client: SupabaseClient | null = null;

export function getSupabase(env: Env): SupabaseClient {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Reset client (for testing)
export function resetSupabaseClient(): void {
  client = null;
}
