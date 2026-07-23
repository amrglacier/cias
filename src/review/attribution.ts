// ============================================================
// CIAS - Review Subsystem (Evolution Engine)
// SRS Section 5: Post-Match Review & Weight Iteration
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env, Prediction, ReviewResult, AttributionCode, WeightAdjustment, FactorWeights, MatchResult } from '../types';
import { getSupabase } from '../db/client';
import {
  getLockedPrediction, insertReviewResult, getReviewResults,
  getRecentReviews, getConfig, setConfig, insertWeightAdjustment,
  logError, getErrorCount, clearErrorCount,
} from '../db/repository';
import { DEFAULT_FACTOR_WEIGHTS, SYSTEM_CONSTANTS } from '../config/defaults';

// ============================================================
// Post-Match Review: Attribution Analysis
// ============================================================

/**
 * SRS 5.1: Run post-match review for a given match.
 * Determine attribution code and responsible party.
 */
export async function runPostMatchReview(
  env: Env,
  matchId: string,
  actualResult: MatchResult,
  actualFt: string,
  actualHt?: string
): Promise<ReviewResult> {
  const db = getSupabase(env);
  console.log(`[Review] Post-match review for ${matchId}: actual=${actualResult}`);

  // Get locked FINAL prediction
  const prediction = await getLockedPrediction(db, matchId);
  if (!prediction) throw new Error(`No locked prediction for ${matchId}`);

  // SRS 5.1: Attribution determination
  const { code, party, detail, errorType, isUpset } = await determineAttribution(
    prediction, actualResult, actualFt, db
  );

  const review: ReviewResult = {
    matchId,
    predictionId: prediction.id!,
    actualResult,
    actualFt,
    actualHt,
    attributionCode: code,
    attributionParty: party,
    attributionDetail: detail,
    errorType,
    isUpset,
  };

  const reviewId = await insertReviewResult(db, review);
  console.log(`[Review] Attribution: ${code} (${party})`);

  // Log error for weight iteration tracking
  if (party === 'logic') {
    const factorId = mapAttributionToFactor(code);
    await logError(db, factorId, errorType, matchId);
  }

  // Check for trend-based weight adjustment
  await checkTrendAndAdjust(db, code);

  // Check daily hit rate for circuit breaker
  await checkDailyHitRate(db);

  return { ...review, id: reviewId };
}

// ============================================================
// SRS 5.1: Attribution Rules
// ============================================================

async function determineAttribution(
  prediction: Prediction,
  actualResult: MatchResult,
  actualFt: string,
  db: SupabaseClient
): Promise<{
  code: AttributionCode;
  party: 'data' | 'logic';
  detail: string;
  errorType: string;
  isUpset: boolean;
}> {
  const predictedResult = prediction.primaryResult;
  const correct = predictedResult === actualResult;

  // Parse actual score
  const [actualHome, actualAway] = actualFt.split(':').map(Number);
  const [predHome, predAway] = prediction.primaryFt.split(':').map(Number);
  const actualTotal = actualHome + actualAway;
  const predTotal = predHome + predAway;
  const totalDiff = Math.abs(actualTotal - predTotal);

  // Check if it's an upset (D1)
  const isUpset = checkUpset(prediction, actualResult);

  // SRS 5.1 Attribution Rules
  if (!correct) {
    // A1: Win/Draw/Loss wrong, total goals close
    if (totalDiff <= 1) {
      return {
        code: 'A1',
        party: 'logic',
        detail: `Result wrong but goal total close (diff=${totalDiff}). Direction misjudgment.`,
        errorType: 'direction_error_close',
        isUpset,
      };
    }

    // A2: Win/Draw/Loss wrong, total goals far off
    return {
      code: 'A2',
      party: 'logic',
      detail: `Result wrong and goal total far off (diff=${totalDiff}). Fundamental misjudgment.`,
      errorType: 'direction_error_far',
      isUpset,
    };
  }

  // Result correct but check for signal-related issues
  // C1: Sharp Move not followed, result would have been correct
  const hasSharpSignal = prediction.marketSignalIds.length > 0 &&
    prediction.logicTrace.probabilityCalibration?.mktSigAdj === 0;
  if (hasSharpSignal) {
    return {
      code: 'C1',
      party: 'logic',
      detail: 'Sharp move signal not followed. Filtering too strict.',
      errorType: 'signal_filter_too_strict',
      isUpset: false,
    };
  }

  // C2: Steam Move followed, result opposite
  const probCalib = prediction.logicTrace.probabilityCalibration;
  const followedSteam = prediction.marketSignalIds.length > 0 &&
    probCalib != null &&
    probCalib.mktSigAdj !== 0 &&
    probCalib.mktSigAdj < 0;
  if (followedSteam && !correct) {
    return {
      code: 'C2',
      party: 'logic',
      detail: 'Steam move followed but result was opposite. Filtering too loose.',
      errorType: 'signal_filter_too_loose',
      isUpset,
    };
  }

  // D1: Actual upset, prediction didn't predict upset
  if (isUpset) {
    return {
      code: 'D1',
      party: 'logic',
      detail: 'Actual result was an upset not predicted.',
      errorType: 'upset_missed',
      isUpset: true,
    };
  }

  // D3: Ignored odds bias (e.g. 1.44 death odds)
  if (prediction.logicTrace.probabilityCalibration?.biasZoneAdj === 0) {
    // Check if odds zone was death odds
    const factors = prediction.keyFactors;
    if (factors.F10 && factors.F10.value === 0) {
      return {
        code: 'D3',
        party: 'logic',
        detail: 'Odds zone bias (e.g. 1.44) was ignored in probability calibration.',
        errorType: 'odds_bias_ignored',
        isUpset,
      };
    }
  }

  // D4: Unadjusted/smoothing failure leading to OWF inflation
  if (prediction.logicTrace.unadjustedWarning) {
    return {
      code: 'D4',
      party: prediction.logicTrace.bayesianApplied ? 'logic' : 'data',
      detail: 'Unadjusted data or smoothing failure led to OWF inflation.',
      errorType: 'unadjusted_data',
      isUpset,
    };
  }

  // D2: L3 source fact denied by L1 source (data agent issue)
  // Check if data agent provided conflicting information
  // This would require cross-referencing data sources in production
  // For now, check if evidence pack had low confidence
  if (prediction.logicTrace.bayesianApplied === false &&
      prediction.logicTrace.unadjustedWarning === false &&
      !correct) {
    return {
      code: 'D2',
      party: 'data',
      detail: 'L3 source fact was denied by L1 source. Data conflict.',
      errorType: 'data_conflict',
      isUpset,
    };
  }

  // Default: correct prediction, no attribution needed
  return {
    code: 'A1', // Fallback (shouldn't normally reach here if correct)
    party: 'logic',
    detail: 'Prediction was correct, no significant attribution issue.',
    errorType: 'none',
    isUpset: false,
  };
}

function checkUpset(prediction: Prediction, actualResult: MatchResult): boolean {
  // Upset = predicted strong favorite but result was opposite
  const probs = prediction.logicTrace.probabilityCalibration;
  if (!probs) return false;

  const maxProb = Math.max(probs.homeWinProb, probs.drawProb, probs.awayWinProb);
  const predictedResult = prediction.primaryResult;

  // If predicted with > 65% confidence and wrong
  if (maxProb > 0.65 && predictedResult !== actualResult) {
    return true;
  }

  return false;
}

function mapAttributionToFactor(code: AttributionCode): string {
  const mapping: Record<AttributionCode, string> = {
    A1: 'F1',    // OWF issue
    A2: 'F1',    // OWF fundamental issue
    C1: 'F11',   // Market signal filtering
    C2: 'F11',   // Market signal filtering
    D1: 'F12',   // Risk weight
    D2: 'F1',    // Data quality
    D3: 'F10',   // Odds zone bias
    D4: 'F1',    // Unadjusted data
  };
  return mapping[code];
}

// ============================================================
// SRS 5.2: Weight Iteration
// ============================================================

/**
 * SRS 5.2: Trend-based weight adjustment.
 * - Single match doesn't trigger adjustment
 * - Trend: 3 consecutive same-type errors
 * - Max adjustment: 10% per change
 */
async function checkTrendAndAdjust(db: SupabaseClient, attributionCode: AttributionCode): Promise<void> {
  const factorId = mapAttributionToFactor(attributionCode);
  const errorCount = await getErrorCount(db, factorId, attributionCode);

  console.log(`[Review] Error count for ${factorId}/${attributionCode}: ${errorCount}`);

  if (errorCount >= SYSTEM_CONSTANTS.REVIEW_TREND_ERROR_COUNT) {
    // SRS: Trend detected, adjust weight
    const weights = await getFactorWeights(db);
    const oldWeight = getWeightForFactor(weights, factorId);

    // SRS: Single adjustment <= 10%
    const adjustmentPct = Math.min(
      SYSTEM_CONSTANTS.REVIEW_ADJUSTMENT_MAX_PCT,
      5 // Default 5% adjustment
    );
    const newWeight = oldWeight * (1 + adjustmentPct / 100);

    // Clamp to reasonable range
    const clampedWeight = Math.max(0.01, Math.min(1.0, newWeight));

    console.log(`[Review] Adjusting ${factorId}: ${oldWeight} -> ${clampedWeight} (${adjustmentPct}%)`);

    const adjustment: WeightAdjustment = {
      factorId,
      factorName: factorId,
      oldWeight,
      newWeight: clampedWeight,
      adjustmentPct,
      triggerReason: `${errorCount} consecutive ${attributionCode} errors`,
      matchCount: errorCount,
    };

    await insertWeightAdjustment(db, adjustment);

    // Update system_config with new weights
    await updateWeightInConfig(db, factorId, clampedWeight);

    // Clear error count after adjustment
    await clearErrorCount(db, factorId, attributionCode);
  }
}

/**
 * SRS 5.2: Circuit breaker for weight iteration.
 * - Daily hit rate < 30% -> pause auto-adjustment, trigger manual audit
 */
async function checkDailyHitRate(db: SupabaseClient): Promise<void> {
  const recentReviews = await getRecentReviews(db, 10); // Last 10 reviews

  if (recentReviews.length < 5) return; // Not enough data

  // Count correct predictions (no significant attribution)
  const correctCount = recentReviews.filter(r =>
    r.errorType === 'none' || r.attributionCode === 'A1' && r.attributionDetail.includes('correct')
  ).length;

  const hitRate = (correctCount / recentReviews.length) * 100;

  if (hitRate < SYSTEM_CONSTANTS.REVIEW_HITRATE_THRESHOLD) {
    console.warn(`[Review] Daily hit rate ${hitRate.toFixed(1)}% < ${SYSTEM_CONSTANTS.REVIEW_HITRATE_THRESHOLD}%, pausing auto-adjustment`);

    // Set config flag to pause auto-adjustment
    const config = await getConfig(db, 'review_config');
    const reviewConfig = (config && typeof config === 'object') ? config : {};
    await setConfig(db, 'review_config', {
      ...reviewConfig,
      auto_adjust_paused: true,
      pause_reason: `Hit rate ${hitRate.toFixed(1)}% below threshold`,
      paused_at: new Date().toISOString(),
    });

    // In production, this would trigger a notification to the owner
    console.warn(`[Review] MANUAL AUDIT REQUIRED: Auto-adjustment paused due to low hit rate`);
  }
}

// ============================================================
// Helpers
// ============================================================

async function getFactorWeights(db: SupabaseClient): Promise<FactorWeights> {
  const configValue = await getConfig(db, 'factor_weights');
  if (configValue && typeof configValue === 'object') {
    return { ...DEFAULT_FACTOR_WEIGHTS, ...(configValue as Record<string, number>) } as FactorWeights;
  }
  return { ...DEFAULT_FACTOR_WEIGHTS };
}

function getWeightForFactor(weights: FactorWeights, factorId: string): number {
  const mapping: Record<string, keyof FactorWeights> = {
    F1: 'w1', F2: 'w2', F3: 'w3', F4: 'w4',
    F5: 'inj_home', F6: 'inj_away',
    F10: 'bias_zone_max', F11: 'mkt_sig_range',
    F12: 'mkt_sig_range', // F12 doesn't have a direct weight, use adjacent
  };
  const key = mapping[factorId] || 'w1';
  return weights[key];
}

async function updateWeightInConfig(db: SupabaseClient, factorId: string, newValue: number): Promise<void> {
  const weights = await getFactorWeights(db);
  const mapping: Record<string, keyof FactorWeights> = {
    F1: 'w1', F2: 'w2', F3: 'w3', F4: 'w4',
    F5: 'inj_home', F6: 'inj_away',
    F10: 'bias_zone_max', F11: 'mkt_sig_range',
  };
  const key = mapping[factorId];
  if (key) {
    const updated = { ...weights, [key]: newValue };
    await setConfig(db, 'factor_weights', updated);
  }
}
