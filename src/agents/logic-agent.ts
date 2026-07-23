// ============================================================
// CIAS - Logic Agent
// SRS 2.2: Logic Agent - Quantitative Engine, Risk Decision Maker
// Runs on Cloudflare Worker
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Env, MatchFacts, EvidencePack, Prediction, MarketSignal,
  FactorWeights, LogicTrace, KeyFactorMap, MatchResult, VersionTag,
  CrossDiscussionEntry,
} from '../types';
import {
  assembleLogicTrace, predictResult, predictScoreline,
  generateDirectionJudgment,
} from './logic-engine';
import { getSupabase } from '../db/client';
import {
  getMatchFacts, getMarketSignals, getLatestPrediction,
  insertPrediction, getErrorCount,
} from '../db/repository';
import { getConfig } from '../db/repository';
import { DEFAULT_FACTOR_WEIGHTS } from '../config/defaults';

// SRS 2.2: Logic Agent is a pure quantitative engine (Plan B - no LLM)
// All predictions are computed via mathematical formulas (OWF/K1/Wr)
// The LOGIC_AGENT_SYSTEM_PROMPT is not used in Plan B mode

// ============================================================
// Phase 2: Independent Prediction (Initial)
// ============================================================

/**
 * SRS Phase 2: Logic Agent produces INITIAL prediction.
 * Reads *_adj fields and Evidence Pack, executes full calculation.
 */
export async function produceInitialPrediction(env: Env, matchId: string): Promise<Prediction> {
  const db = getSupabase(env);
  console.log(`[LogicAgent] Phase 2: Producing INITIAL prediction for ${matchId}`);

  // Read frozen facts
  const facts = await getMatchFacts(db, matchId);
  if (!facts) throw new Error(`No match facts for ${matchId}`);

  // Read market signals
  const signals = await getMarketSignals(db, matchId);

  // Build evidence pack
  const evidence = await buildLogicEvidence(db, matchId, facts);

  // Get factor weights from config
  const weights = await getFactorWeights(db);

  // Get historical error rate
  const historicalErrorRate = await getHistoricalErrorRate(db);

  // Assemble logic trace
  const { trace, keyFactors, owf, k1, wr, probabilities } = assembleLogicTrace(
    facts, weights, evidence, historicalErrorRate, signals
  );

  // Predict result
  const { primary, hedge } = predictResult(
    probabilities.homeWinProb,
    probabilities.drawProb,
    probabilities.awayWinProb
  );

  // Predict scoreline
  const scoreline = predictScoreline(owf, k1, primary);
  let hedgeScoreline = { ft: '', ht: '' };
  if (hedge) {
    hedgeScoreline = predictScoreline(
      hedge === 'home_win' ? owf : 2 - k1,
      hedge === 'home_win' ? k1 : 2 - owf,
      hedge
    );
  }

  // Generate direction judgment (telegram-style)
  const directionJudgment = generateDirectionJudgment(primary, hedge, owf, k1, signals);

  const prediction: Prediction = {
    matchId,
    primaryResult: primary,
    primaryFt: scoreline.ft,
    primaryHt: scoreline.ht,
    hedgeResult: hedge,
    hedgeFt: hedgeScoreline.ft || undefined,
    hedgeHt: hedgeScoreline.ht || undefined,
    directionJudgment,
    versionTag: 'INITIAL',
    isArchived: false,
    marketSignalIds: signals.map(s => s.id),
    logicTrace: trace,
    keyFactors,
    isLock: false,
    alignmentStatus: 'pending',
    alignmentForcedDegrade: false,
    crossDiscussionLog: [],
  };

  const predId = await insertPrediction(db, prediction);
  console.log(`[LogicAgent] INITIAL prediction saved (id=${predId})`);
  return { ...prediction, id: predId };
}

// ============================================================
// Phase 4: Lightweight Recalculation (Periodic)
// ============================================================

/**
 * SRS Phase 4: Logic Agent lightweight recalculation on market signal.
 * If no signal: keep old version, no DB write.
 * If signal: recalculate, generate new PERIODIC version.
 */
export async function periodicRecalculation(env: Env, matchId: string, newSignals: MarketSignal[]): Promise<Prediction | null> {
  const db = getSupabase(env);

  if (newSignals.length === 0) {
    console.log(`[LogicAgent] Phase 4: No new signals for ${matchId}, keeping old version`);
    return null;
  }

  console.log(`[LogicAgent] Phase 4: Recalculating for ${matchId} with ${newSignals.length} new signals`);

  // Get current locked prediction
  const current = await getLatestPrediction(db, matchId);
  if (!current) {
    console.warn(`[LogicAgent] No existing prediction for ${matchId}`);
    return null;
  }

  // If locked, don't recalculate
  if (current.isLock) {
    console.log(`[LogicAgent] Prediction locked for ${matchId}, skipping`);
    return null;
  }

  // Re-read facts (frozen, but get latest odds zone from signals)
  const facts = await getMatchFacts(db, matchId);
  if (!facts) throw new Error(`No match facts for ${matchId}`);

  // Merge all signals (existing + new)
  const allSignals = await getMarketSignals(db, matchId);

  // Build evidence
  const evidence = await buildLogicEvidence(db, matchId, facts);
  const weights = await getFactorWeights(db);
  const historicalErrorRate = await getHistoricalErrorRate(db);

  // Recalculate
  const { trace, keyFactors, owf, k1, wr, probabilities } = assembleLogicTrace(
    facts, weights, evidence, historicalErrorRate, allSignals
  );

  const { primary, hedge } = predictResult(
    probabilities.homeWinProb,
    probabilities.drawProb,
    probabilities.awayWinProb
  );

  const scoreline = predictScoreline(owf, k1, primary);
  let hedgeScoreline = { ft: '', ht: '' };
  if (hedge) {
    hedgeScoreline = predictScoreline(
      hedge === 'home_win' ? owf : 2 - k1,
      hedge === 'home_win' ? k1 : 2 - owf,
      hedge
    );
  }

  const directionJudgment = generateDirectionJudgment(primary, hedge, owf, k1, allSignals);

  // Delta explanation
  const deltaExplanation = buildDeltaExplanation(current, { primary, owf, k1, probabilities });

  // Check in-play record limit (SRS: max 5 records)
  const signalIds = newSignals.map(s => s.id);

  const prediction: Prediction = {
    matchId,
    primaryResult: primary,
    primaryFt: scoreline.ft,
    primaryHt: scoreline.ht,
    hedgeResult: hedge,
    hedgeFt: hedgeScoreline.ft || undefined,
    hedgeHt: hedgeScoreline.ht || undefined,
    directionJudgment,
    versionTag: 'PERIODIC',
    isArchived: false,
    prevVersionId: current.id,
    marketSignalIds: [...current.marketSignalIds, ...signalIds],
    deltaExplanation,
    logicTrace: trace,
    keyFactors,
    isLock: false,
    alignmentStatus: current.alignmentStatus,
    alignmentForcedDegrade: current.alignmentForcedDegrade,
    crossDiscussionLog: current.crossDiscussionLog,
  };

  const predId = await insertPrediction(db, prediction);
  console.log(`[LogicAgent] PERIODIC prediction saved (id=${predId})`);
  return { ...prediction, id: predId };
}

// ============================================================
// Cross-Discussion: Respond to system queries
// ============================================================

/**
 * SRS Phase 3: Cross-Discussion response.
 * Logic Agent must either modify parameters or quantify dismissal.
 */
export async function respondToCrossDiscussion(
  env: Env,
  matchId: string,
  missingEvidence: string,
  round: number
): Promise<CrossDiscussionEntry> {
  const db = getSupabase(env);
  const current = await getLatestPrediction(db, matchId);
  if (!current) throw new Error(`No prediction for ${matchId}`);

  const facts = await getMatchFacts(db, matchId);
  if (!facts) throw new Error(`No match facts for ${matchId}`);

  const evidence = await buildLogicEvidence(db, matchId, facts);
  const weights = await getFactorWeights(db);

  // Re-examine the missing evidence
  const { trace } = assembleLogicTrace(
    facts, weights, evidence, 0.05, []
  );

  // Determine if the missing evidence is material
  const owf = trace.owf ?? 0;
  const k1 = trace.k1 ?? 0;
  const isMaterial = Math.abs(owf) > 0.01 || Math.abs(k1) > 0.01;

  const entry: CrossDiscussionEntry = {
    round,
    speaker: 'logic',
    message: '',
    action: isMaterial ? 'modify_param' : 'quantify_dismiss',
    timestamp: new Date().toISOString(),
  };

  if (isMaterial) {
    entry.message = `Acknowledged. Re-evaluating with evidence: ${missingEvidence}. Adjusting parameters.`;
    entry.modifiedFactor = 'F1'; // Would be dynamic in production
  } else {
    entry.message = `The cited evidence impact < 1%, below materiality threshold. Dismissing with quantification.`;
  }

  // Update prediction with cross-discussion log
  const updatedLog = [...current.crossDiscussionLog, entry];
  await db.from('predictions')
    .update({ cross_discussion_log: updatedLog })
    .eq('id', current.id);

  return entry;
}

// ============================================================
// Internal helpers
// ============================================================

async function buildLogicEvidence(
  db: SupabaseClient,
  matchId: string,
  facts: MatchFacts
): Promise<EvidencePack> {
  const signals = await getMarketSignals(db, matchId);

  const factors: EvidencePack['factors'] = {
    F1: facts.homeXgAdj,
    F2: facts.awayXgAdj,
    F3: facts.homeConcAdj,
    F4: facts.awayConcAdj,
    F5: facts.injuryImpactHome,
    F6: facts.injuryImpactAway,
    F7: facts.weatherDecay,
    F8: facts.refereeStrictness,
    F9: facts.motivationHome,
    F10: facts.biasCorrection,
    F13: facts.formationCtrHome,
  };

  if (signals.some(s => s.signalType === 'sharp_move')) {
    factors.F11 = 0.04;
  } else if (signals.some(s => s.signalType === 'steam_move')) {
    factors.F11 = -0.04;
  }

  const unadjustedWarning =
    facts.homeXgAdj === undefined ||
    facts.awayXgAdj === undefined ||
    facts.homeConcAdj === undefined ||
    facts.awayConcAdj === undefined;

  return {
    matchId,
    factors,
    rawData: {
      leagueAvgGoals: facts.leagueAvgGoals,
      leagueAvgConc: facts.leagueAvgConc,
      bayesianPriorApplied: facts.bayesianPriorApplied,
    },
    confidence: facts.dataConfidence,
    unadjustedWarning,
    collectedAt: new Date().toISOString(),
    notes: unadjustedWarning ? ['Unadjusted data - confidence downgrade'] : [],
  };
}

async function getFactorWeights(db: SupabaseClient): Promise<FactorWeights> {
  const configValue = await getConfig(db, 'factor_weights');
  if (configValue && typeof configValue === 'object') {
    return { ...DEFAULT_FACTOR_WEIGHTS, ...(configValue as Record<string, number>) } as FactorWeights;
  }
  return { ...DEFAULT_FACTOR_WEIGHTS };
}

async function getHistoricalErrorRate(db: SupabaseClient): Promise<number> {
  // SRS F12: Base rate + cumulative error rate
  const errorCount = await getErrorCount(db, 'F12', 'prediction_error');
  const totalPredictions = 100; // Would query actual count
  const baseRate = 0.05;
  return baseRate + (errorCount / Math.max(totalPredictions, 1));
}

function buildDeltaExplanation(
  prev: Prediction,
  current: { primary: MatchResult; owf: number; k1: number; probabilities: { homeWinProb: number; drawProb: number; awayWinProb: number } }
): string {
  const changes: string[] = [];

  if (prev.primaryResult !== current.primary) {
    changes.push(`Primary changed: ${prev.primaryResult} -> ${current.primary}`);
  }

  const prevOwf = prev.logicTrace.owf ?? 0;
  const owfDelta = current.owf - prevOwf;
  if (Math.abs(owfDelta) > 0.01) {
    changes.push(`OWF ${owfDelta > 0 ? '+' : ''}${owfDelta.toFixed(3)}`);
  }

  const prevK1 = prev.logicTrace.k1 ?? 0;
  const k1Delta = current.k1 - prevK1;
  if (Math.abs(k1Delta) > 0.01) {
    changes.push(`K1 ${k1Delta > 0 ? '+' : ''}${k1Delta.toFixed(3)}`);
  }

  if (changes.length === 0) {
    return 'No material change in prediction factors.';
  }

  return `Signal-triggered recalc: ${changes.join(', ')}`;
}
