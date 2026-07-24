// ============================================================
// CIAS - Shared evidence building logic
// Extracted from data-agent.ts and logic-agent.ts to eliminate duplication
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchFacts, EvidencePack, MarketSignal } from '../types';
import { getMarketSignals } from '../db/repository';
import { ODDS_ZONES } from '../config/defaults';

/**
 * Build EvidencePack from match facts and market signals.
 * Shared by Data Agent (buildEvidencePack) and Logic Agent (buildLogicEvidence).
 */
export async function buildEvidenceFromFacts(
  db: SupabaseClient,
  matchId: string,
  facts: MatchFacts,
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

  // Add market signal factor if any
  if (signals.some((s: MarketSignal) => s.signalType === 'sharp_move')) {
    factors.F11 = 0.04;
  } else if (signals.some((s: MarketSignal) => s.signalType === 'steam_move')) {
    factors.F11 = -0.04;
  }

  const unadjustedWarning =
    facts.homeXgAdj === undefined ||
    facts.awayXgAdj === undefined ||
    facts.homeConcAdj === undefined ||
    facts.awayConcAdj === undefined;

  const notes: string[] = [];
  if (unadjustedWarning) {
    notes.push('Some *_adj fields are missing - confidence downgrade applied');
  }
  if (facts.bayesianPriorApplied) {
    notes.push('Bayesian prior applied (opponent sample < 5)');
  }
  if (facts.oddsZone === ODDS_ZONES.DEATH_ODDS) {
    notes.push('Death odds detected - special bias correction applied');
  }

  return {
    matchId,
    factors,
    rawData: {
      homeXgRaw: facts.homeXgAdj,
      awayXgRaw: facts.awayXgAdj,
      homeConcRaw: facts.homeConcAdj,
      awayConcRaw: facts.awayConcAdj,
      leagueAvgGoals: facts.leagueAvgGoals,
      leagueAvgConc: facts.leagueAvgConc,
      bayesianPriorApplied: facts.bayesianPriorApplied,
    },
    confidence: facts.dataConfidence,
    unadjustedWarning,
    collectedAt: new Date().toISOString(),
    notes,
  };
}
