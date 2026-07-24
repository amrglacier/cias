// ============================================================
// CIAS - Circuit Breaker
// SRS 2.3: API quota < 10% -> stop non-core; T_fuse -> no writes
// Uses KV (CIAS_LOCKS) for cross-instance state sharing.
// ============================================================

import type { Env, CircuitBreakerState } from '../types';
import { checkApiBudget } from '../agents/data-agent';
import { SYSTEM_CONSTANTS } from '../config/defaults';

// Local in-memory cache (per-isolate, short TTL to reduce KV reads)
let cachedState: CircuitBreakerState | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds (shorter since we now back it with KV)

const KV_KEY = 'circuit_breaker_state';

/**
 * Get current circuit breaker state.
 * SRS: If API budget < 10%, trip breaker and block non-core requests.
 * Reads tFusePassed from KV so all Worker isolates see the same state.
 */
export async function getCircuitBreakerState(env: Env): Promise<CircuitBreakerState> {
  const now = Date.now();
  if (cachedState && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
  }

  // Read tFusePassed from KV (cross-instance shared state)
  let tFusePassed = false;
  try {
    const raw = await env.CIAS_LOCKS.get(KV_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as { tFusePassed?: boolean };
      tFusePassed = stored.tFusePassed ?? false;
    }
  } catch {
    // KV read failed - default to false (safe: allow writes)
    console.warn('[CircuitBreaker] Failed to read state from KV');
  }

  // Check API budgets for all external APIs
  const apiNames = ['api-football', 'odds-api'];
  let minBudget = 100;

  for (const apiName of apiNames) {
    try {
      const budget = await checkApiBudget(env, apiName);
      minBudget = Math.min(minBudget, budget);
    } catch (e) {
      console.warn(`[CircuitBreaker] Failed to check budget for ${apiName}:`, e);
    }
  }

  const isTripped = minBudget < SYSTEM_CONSTANTS.API_BUDGET_CRITICAL_PERCENT;

  const state: CircuitBreakerState = {
    apiBudgetRemaining: minBudget,
    isTripped,
    tFusePassed,
    nonCoreRequestsBlocked: isTripped,
  };

  cachedState = state;
  cacheTimestamp = now;
  return state;
}

/**
 * SRS: Check if a non-core API call can proceed.
 */
export async function canMakeNonCoreRequest(env: Env): Promise<boolean> {
  const state = await getCircuitBreakerState(env);
  return !state.isTripped;
}

/**
 * SRS: T_fuse enforcement - after fuse, no writes allowed.
 * Persists to KV so all Worker isolates see the same state.
 */
export async function setTFusePassed(env: Env): Promise<void> {
  // Write to KV for cross-instance visibility
  try {
    await env.CIAS_LOCKS.put(KV_KEY, JSON.stringify({ tFusePassed: true }));
  } catch {
    console.warn('[CircuitBreaker] Failed to write T_fuse state to KV');
  }

  // Also update local cache immediately
  if (cachedState) {
    cachedState.tFusePassed = true;
  } else {
    cachedState = {
      apiBudgetRemaining: 100,
      isTripped: false,
      tFusePassed: true,
      nonCoreRequestsBlocked: false,
    };
  }
  cacheTimestamp = Date.now();
}

/**
 * SRS: Check if writes are blocked (post T_fuse).
 */
export function canWrite(state: CircuitBreakerState | null): boolean {
  if (!state) return true;
  return !state.tFusePassed;
}

/**
 * Reset circuit breaker cache (for testing).
 * Note: this only clears the local in-memory cache, not the KV state.
 * Tests that need a clean KV state should mock env.CIAS_LOCKS.
 */
export function resetCircuitBreakerCache(): void {
  cachedState = null;
  cacheTimestamp = 0;
}
