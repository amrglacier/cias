// ============================================================
// CIAS - ConcurrencyLockDurableObject
// Implements SRS 3.3: Atomic concurrency control for sliding window
// ============================================================

import { DurableObject } from 'cloudflare:workers';

interface LockState {
  holder: string;
  acquiredAt: number;
}

export class ConcurrencyLockDO extends DurableObject {
  // In-memory lock state (single-island, eventually consistent)
  private locks: Map<string, LockState> = new Map();
  private readonly LOCK_TTL_MS = 30_000; // 30 seconds

  async acquire(matchId: string, caller: string): Promise<boolean> {
    const existing = this.locks.get(matchId);
    const now = Date.now();

    // Check TTL expiry
    if (existing && now - existing.acquiredAt > this.LOCK_TTL_MS) {
      this.locks.delete(matchId);
    }

    if (!this.locks.has(matchId)) {
      this.locks.set(matchId, { holder: caller, acquiredAt: now });
      return true;
    }
    return false;
  }

  async release(matchId: string, caller: string): Promise<boolean> {
    const existing = this.locks.get(matchId);
    if (existing && existing.holder === caller) {
      this.locks.delete(matchId);
      return true;
    }
    return false;
  }

  async forceRelease(matchId: string): Promise<void> {
    this.locks.delete(matchId);
  }

  // Atomic cleanup: execute a function while holding the lock
  async withLock<T>(
    matchId: string,
    caller: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const acquired = await this.acquire(matchId, caller);
    if (!acquired) {
      throw new Error(`ConcurrencyLock: match ${matchId} is locked by another caller`);
    }
    try {
      return await fn();
    } finally {
      await this.release(matchId, caller);
    }
  }

  override async alarm(): Promise<void> {
    // Clean expired locks
    const now = Date.now();
    for (const [key, state] of this.locks) {
      if (now - state.acquiredAt > this.LOCK_TTL_MS) {
        this.locks.delete(key);
      }
    }
  }
}
