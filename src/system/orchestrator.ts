// ============================================================
// CIAS - System Orchestrator
// SRS Section 4: SOP Workflow (5 Phases)
// SRS 2.3: Scheduling Center
// ============================================================

import type { Env, MatchInfo, Prediction, MarketSignal, CrossDiscussionEntry } from '../types';
import { getSupabase } from '../db/client';
import {
  gatherFundamentals, buildEvidencePack, captureOddsSnapshot,
  refreshDynamicFactors,
} from '../agents/data-agent';
import {
  produceInitialPrediction, periodicRecalculation,
  respondToCrossDiscussion,
} from '../agents/logic-agent';
import { enforceConstitution } from './constitution';
import { getCircuitBreakerState, setTFusePassed, canWrite } from './circuit-breaker';
import {
  getLatestPrediction, lockPrediction, getInPlayPredictions,
  atomicDeleteOldestInPlay, getMatchFacts, updateMatchFactsStatus,
} from '../db/repository';
import { SYSTEM_CONSTANTS } from '../config/defaults';

// ============================================================
// Phase 1 (T0): Fundamentals & Market Data Governance
// ============================================================

export async function runPhase1_T0(env: Env, match: MatchInfo): Promise<void> {
  console.log(`[System] === Phase 1 (T0): Fundamentals for ${match.matchId} ===`);

  // SRS: Step 1 - Get fixtures (via API-Football)
  // SRS: Step 2 - Data enrichment (Bayesian smoothing)
  await gatherFundamentals(env, match);

  // SRS: Step 3 - Freeze snapshot
  const db = getSupabase(env);
  await updateMatchFactsStatus(db, match.matchId, 'frozen');

  // SRS: T0 后严禁调用除 Odds API 外的任何外部接口
  // (Data Agent禁令: T0后禁止调用除Odds API外的任何外部接口)
  console.log(`[System] Phase 1 complete: Data frozen for ${match.matchId}`);
}

// ============================================================
// Phase 2: Dual Model Independent Prediction (Initial)
// ============================================================

export async function runPhase2_Initial(env: Env, matchId: string): Promise<Prediction> {
  console.log(`[System] === Phase 2: Initial Prediction for ${matchId} ===`);

  // SRS: Data Agent produces Evidence Pack
  const evidence = await buildEvidencePack(env, matchId);
  console.log(`[System] Evidence Pack built: confidence=${evidence.confidence}`);

  // SRS: Logic Agent reads *_adj, executes full calculation
  const prediction = await produceInitialPrediction(env, matchId);

  console.log(`[System] Phase 2 complete: INITIAL prediction stored`);
  return prediction;
}

// ============================================================
// Phase 3: Cross-Discussion
// ============================================================

export async function runPhase3_CrossDiscussion(env: Env, matchId: string): Promise<Prediction> {
  console.log(`[System] === Phase 3: Cross-Discussion for ${matchId} ===`);
  const db = getSupabase(env);

  // Get current prediction
  const prediction = await getLatestPrediction(db, matchId);
  if (!prediction) throw new Error(`No prediction for ${matchId}`);

  // Get evidence pack
  const evidence = await buildEvidencePack(env, matchId);

  // SRS: Step 1 - Difference detection
  const discrepancies = detectDiscrepancies(prediction, evidence);
  if (discrepancies.length === 0) {
    console.log(`[System] No discrepancies detected, alignment achieved`);
    await db.from('predictions')
      .update({ alignment_status: 'aligned' })
      .eq('id', prediction.id);
    return { ...prediction, alignmentStatus: 'aligned' };
  }

  // SRS: Step 2 - Cross-discussion rounds (max 2)
  const maxRounds = SYSTEM_CONSTANTS.CROSS_DISCUSSION_MAX_ROUNDS;
  let aligned = false;

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`[System] Cross-discussion round ${round}/${maxRounds}`);

    // System queries Logic Agent about each discrepancy
    for (const discrepancy of discrepancies) {
      const response = await respondToCrossDiscussion(
        env, matchId, discrepancy, round
      );

      if (response.action === 'modify_param') {
        // Logic Agent accepted and modified
        aligned = true;
      }
      // If 'quantify_dismiss', continue to next round
    }

    if (aligned) break;
  }

  // SRS: Step 3 - Final adjudication
  if (!aligned) {
    console.log(`[System] Cross-discussion failed after ${maxRounds} rounds, forcing degrade`);
    // SRS: 调度中心行使最终裁决权
    await db.from('predictions')
      .update({
        alignment_status: 'forced_degrade',
        alignment_forced_degrade: true,
        hedge_result: prediction.hedgeResult || prediction.primaryResult, // Force hedge retention
      })
      .eq('id', prediction.id);

    const updated = await getLatestPrediction(db, matchId);
    return updated!;
  }

  await db.from('predictions')
    .update({ alignment_status: 'aligned' })
    .eq('id', prediction.id);

  const final = await getLatestPrediction(db, matchId);
  return final!;
}

/**
 * SRS Phase 3 Step 1: Detect discrepancies between Logic Agent prediction
 * and Data Agent evidence.
 */
function detectDiscrepancies(
  prediction: Prediction,
  evidence: { factors: Record<string, unknown>; notes: string[] }
): string[] {
  const discrepancies: string[] = [];

  // Check if Logic Agent ignored unadjusted data
  if (evidence.notes.some(n => n.includes('Unadjusted'))) {
    if (!prediction.logicTrace.unadjustedWarning) {
      discrepancies.push('Evidence pack flags unadjusted data but logic_trace does not mark warning');
    }
  }

  // Check if key factors from evidence are reflected in prediction
  for (const note of evidence.notes) {
    if (note.includes('Death odds')) {
      // Check if prediction accounts for death odds bias
      if (!prediction.keyFactors.F10 || prediction.keyFactors.F10.value === 0) {
        discrepancies.push('Death odds detected in evidence but F10 (bias_correction) is zero');
      }
    }
    if (note.includes('Bayesian prior')) {
      if (!prediction.logicTrace.bayesianApplied) {
        discrepancies.push('Bayesian prior was applied in data but logic_trace does not reflect it');
      }
    }
  }

  return discrepancies;
}

// ============================================================
// Phase 4: In-Play Monitoring & Lightweight Recalculation
// ============================================================

export async function runPhase4_InPlayMonitoring(env: Env, match: MatchInfo): Promise<Prediction | null> {
  console.log(`[System] === Phase 4: In-Play Monitoring for ${match.matchId} ===`);
  const db = getSupabase(env);

  // SRS: Data Agent - refresh DYNAMIC factors (injuries, lineup, referee, weather)
  // Static data (team season stats) is NOT re-fetched - uses cache
  try {
    await refreshDynamicFactors(env, match);
    console.log(`[System] Dynamic factors refreshed for ${match.matchId}`);
  } catch (err) {
    console.warn(`[System] Dynamic refresh failed, continuing with stale data:`, err);
  }

  // SRS: Data Agent - capture odds snapshot
  const { signals } = await captureOddsSnapshot(env, match.matchId);

  // SRS: Signal detection - Sharp Move (>=5%) or Steam Move
  if (signals.length === 0) {
    console.log(`[System] No signals detected, keeping old version`);
    return null;
  }

  console.log(`[System] ${signals.length} signals detected, triggering recalculation`);

  // SRS: Logic Agent - lightweight recalculation
  const newPrediction = await periodicRecalculation(env, match.matchId, signals);

  if (newPrediction) {
    // SRS: Window maintenance - check in-play record count
    const inPlayPredictions = await getInPlayPredictions(db, match.matchId);
    if (inPlayPredictions.length >= SYSTEM_CONSTANTS.INPLAY_MAX_RECORDS) {
      // SRS: Atomic deletion of oldest record
      await atomicDeleteOldestInPlay(db, match.matchId);
      console.log(`[System] Cleaned up oldest in-play record (limit: ${SYSTEM_CONSTANTS.INPLAY_MAX_RECORDS})`);
    }
  }

  return newPrediction;
}

// ============================================================
// Phase 5: Final Publish (T_fuse)
// ============================================================

export async function runPhase5_FinalPublish(env: Env, matchId: string): Promise<Prediction> {
  console.log(`[System] === Phase 5: Final Publish (T_fuse) for ${matchId} ===`);
  const db = getSupabase(env);

  // Get latest prediction
  const latest = await getLatestPrediction(db, matchId);
  if (!latest) throw new Error(`No prediction to publish for ${matchId}`);

  // SRS: Constitutional check
  const { canPublish, errors } = enforceConstitution(latest);
  if (!canPublish) {
    console.error(`[System] Constitutional violations:`, errors);
    throw new Error(`Constitutional check failed: ${errors.join('; ')}`);
  }

  // SRS: Circuit breaker - T_fuse
  await setTFusePassed(env);
  const cbState = await getCircuitBreakerState(env);
  if (!canWrite(cbState)) {
    throw new Error('Circuit breaker: writes blocked after T_fuse');
  }

  // SRS: Lock prediction
  await lockPrediction(db, latest.id!);
  console.log(`[System] Phase 5 complete: FINAL prediction locked`);

  const final = await getLatestPrediction(db, matchId);
  return final!;
}

// ============================================================
// Full SOP Pipeline Runner
// ============================================================

export async function runFullSOP(env: Env, match: MatchInfo): Promise<Prediction> {
  // Phase 1: T0
  await runPhase1_T0(env, match);

  // Phase 2: Initial
  await runPhase2_Initial(env, match.matchId);

  // Phase 3: Cross-Discussion
  await runPhase3_CrossDiscussion(env, match.matchId);

  // Phase 4: Skip (in-play monitoring runs via Cron)
  // Phase 5: Final publish
  return await runPhase5_FinalPublish(env, match.matchId);
}
