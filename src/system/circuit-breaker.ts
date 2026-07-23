// ============================================================
// CIAS - Circuit Breaker
// SRS 2.3: API quota < 10% -> stop non-core; T_fuse -> no writes
// ============================================================

import type { Env, CircuitBreakerState } from '../types';
import { checkApiBudget } from '../agents/data-agent';
import { getSupabase } from '../db/client';
import { SYSTEM_CONSTANTS } from '../config/defaults';

let cachedState: CircuitBreakerState | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Get current circuit breaker state.
 * SRS: If API budget < 10%, trip breaker and block non-core requests.
 */
export async function getCircuitBreakerState(env: Env): Promise<CircuitBreakerState> {
  const now = Date.now();
  if (cachedState && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
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
    tFusePassed: false, // Set by SOP orchestrator
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
 */
export function setTFusePassed(): void {
  if (cachedState) {
    cachedState.tFusePassed = true;
  }
}

/**
 * SRS: Check if writes are blocked (post T_fuse).
 */
export function canWrite(cachedState: CircuitBreakerState | null): boolean {
  if (!cachedState) return true;
  return !cachedState.tFusePassed;
}

/**
 * Reset circuit breaker cache (for testing).
 */
export function resetCircuitBreakerCache(): void {
  cachedState = null;
  cacheTimestamp = 0;
}
