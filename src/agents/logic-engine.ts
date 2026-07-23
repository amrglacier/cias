// ============================================================
// CIAS - Logic Engine: OWF / K1 / Wr Formulas
// SRS 3.2.2: Core Formulas
// ============================================================

import type { FactorWeights, LogicTrace, KeyFactorMap, MatchFacts, EvidencePack, MarketSignal } from '../types';

/**
 * Calculate Offensive Weighted Factor (OWF)
 * SRS: OWF = (xG_h_adj * w1 + xG_a_adj * w2) * W_th * Motiv
 *
 * Where:
 *   xG_h_adj = home team adjusted xG (F1)
 *   xG_a_adj = away team adjusted xG (F2, reverse direction)
 *   W_th = weather decay (F7)
 *   Motiv = motivation coefficient (F9)
 */
export function calculateOWF(
  facts: MatchFacts,
  weights: FactorWeights,
  mktSigAdj: number = 0,
  formCtrAdj: number = 0
): { value: number; factors: KeyFactorMap } {
  const xg_h = facts.homeXgAdj ?? 0;
  const xg_a = facts.awayXgAdj ?? 0;
  const w_th = facts.weatherDecay;
  const motiv = facts.motivationHome;

  // OWF = (xG_h * w1 + xG_a * w2) * W_th * Motiv + market_signal_adj + formation_counter
  const baseSum = xg_h * weights.w1 + xg_a * weights.w2;
  const owf = baseSum * w_th * motiv + mktSigAdj + formCtrAdj;

  const factors: KeyFactorMap = {
    F1: { value: xg_h, weight: weights.w1, contribution: xg_h * weights.w1, note: 'Home adj xG' },
    F2: { value: xg_a, weight: weights.w2, contribution: xg_a * weights.w2, note: 'Away adj xG (reverse)' },
    F7: { value: w_th, weight: w_th, contribution: w_th, note: 'Weather decay multiplier' },
    F9: { value: motiv, weight: motiv, contribution: motiv, note: 'Motivation coefficient' },
  };

  if (mktSigAdj !== 0) {
    factors.F11 = { value: mktSigAdj, weight: weights.mkt_sig_range, contribution: mktSigAdj, note: 'Sharp/Steam signal micro-adjustment' };
  }
  if (formCtrAdj !== 0) {
    factors.F13 = { value: formCtrAdj, weight: weights.form_ctr_range, contribution: formCtrAdj, note: 'Formation counter' };
  }

  return { value: owf, factors };
}

/**
 * Calculate Defensive Factor (K1)
 * SRS: K1 = (Conc_h_adj * w3 + Ref_st * w8) * (1 - Inj_h)
 *
 * Where:
 *   Conc_h_adj = home adjusted concession rate (F3)
 *   Conc_a_adj = away adjusted concession rate (F4, reverse direction)
 *   Ref_st = referee strictness (F8)
 *   Inj_h = injury impact (F5/F6)
 */
export function calculateK1(
  facts: MatchFacts,
  weights: FactorWeights
): { value: number; factors: KeyFactorMap } {
  const conc_h = facts.homeConcAdj ?? 0;
  const conc_a = facts.awayConcAdj ?? 0;
  const ref_st = facts.refereeStrictness;
  const inj_h = facts.injuryImpactHome;
  const inj_a = facts.injuryImpactAway;

  // K1 = (Conc_h * w3 + Conc_a * w4 + Ref_st * w8_step) * (1 - injury_factor)
  const injuryFactor = Math.max(inj_h, inj_a) * weights.inj_home;
  const baseSum = conc_h * weights.w3 + conc_a * weights.w4;
  const refComponent = ref_st * weights.ref_strictness_step * 5; // scale to meaningful range
  const k1 = (baseSum + refComponent) * (1 - injuryFactor);

  const factors: KeyFactorMap = {
    F3: { value: conc_h, weight: weights.w3, contribution: conc_h * weights.w3, note: 'Home adj concession' },
    F4: { value: conc_a, weight: weights.w4, contribution: conc_a * weights.w4, note: 'Away adj concession (reverse)' },
    F5: { value: inj_h, weight: weights.inj_home, contribution: -injuryFactor, note: 'Home injury impact' },
    F6: { value: inj_a, weight: weights.inj_away, contribution: 0, note: 'Away injury impact' },
    F8: { value: ref_st, weight: weights.ref_strictness_step, contribution: refComponent, note: 'Referee strictness' },
  };

  return { value: k1, factors };
}

/**
 * Calculate Risk Weight (Wr)
 * SRS: Wr = BaseRate + Ref_st + Err_rate
 *
 * Where:
 *   BaseRate = base historical error rate
 *   Ref_st = referee strictness contribution
 *   Err_rate = historical prediction error rate (F12)
 */
export function calculateWr(
  facts: MatchFacts,
  weights: FactorWeights,
  historicalErrorRate: number = 0.05
): { value: number; factors: KeyFactorMap } {
  const baseRate = 0.05; // Base risk
  const refComponent = facts.refereeStrictness * weights.ref_strictness_step * 5;

  const wr = baseRate + refComponent + historicalErrorRate;

  const factors: KeyFactorMap = {
    F8: { value: facts.refereeStrictness, weight: weights.ref_strictness_step, contribution: refComponent, note: 'Referee strictness (Wr component)' },
    F12: { value: historicalErrorRate, weight: 1.0, contribution: historicalErrorRate, note: 'Historical error rate' },
  };

  return { value: wr, factors };
}

/**
 * Calibrate probabilities using odds zone bias.
 * SRS: Bias_zone ranges -0.05 to +0.03
 * SRS: Mkt_sig ranges +/-0.04
 */
export function calibrateProbabilities(
  owf: number,
  k1: number,
  wr: number,
  biasZoneAdj: number,
  mktSigAdj: number
): { homeWinProb: number; drawProb: number; awayWinProb: number; biasZoneAdj: number; mktSigAdj: number } {
  // Base probabilities from OWF and K1
  // Higher OWF -> more likely home win
  // Higher K1 -> more likely draw or away win
  // Higher Wr -> higher variance

  const totalOffensive = owf + (2 - k1); // Inverse K1 = defensive weakness
  const homeBase = Math.exp(owf) / (Math.exp(owf) + Math.exp(2 - k1) + 1);
  const awayBase = Math.exp(2 - k1) / (Math.exp(owf) + Math.exp(2 - k1) + 1);
  const drawBase = 1 / (Math.exp(owf) + Math.exp(2 - k1) + 1);

  // Apply bias zone correction
  let homeProb = homeBase + biasZoneAdj;
  let awayProb = awayBase - biasZoneAdj * 0.5;
  let drawProb = drawBase - biasZoneAdj * 0.5;

  // Apply market signal micro-adjustment
  homeProb += mktSigAdj;
  awayProb -= mktSigAdj * 0.5;
  drawProb -= mktSigAdj * 0.5;

  // Apply risk weight: spread probability based on risk
  const variance = wr * 0.1;
  homeProb = homeProb * (1 - variance) + variance / 3;
  awayProb = awayProb * (1 - variance) + variance / 3;
  drawProb = drawProb * (1 - variance) + variance / 3;

  // Normalize
  const sum = homeProb + drawProb + awayProb;
  homeProb /= sum;
  drawProb /= sum;
  awayProb /= sum;

  return { homeWinProb: homeProb, drawProb, awayWinProb: awayProb, biasZoneAdj, mktSigAdj };
}

/**
 * Determine match result prediction from calibrated probabilities.
 */
export function predictResult(
  homeProb: number,
  drawProb: number,
  awayProb: number
): { primary: 'home_win' | 'draw' | 'away_win'; hedge?: 'home_win' | 'draw' | 'away_win' } {
  const probs = [
    { result: 'home_win' as const, prob: homeProb },
    { result: 'draw' as const, prob: drawProb },
    { result: 'away_win' as const, prob: awayProb },
  ].sort((a, b) => b.prob - a.prob);

  const primary = probs[0].result;
  const hedge = probs[1].prob > 0.2 ? probs[1].result : undefined;

  return { primary, hedge };
}

/**
 * Predict scoreline based on OWF, K1 and probabilities.
 */
export function predictScoreline(
  owf: number,
  k1: number,
  primary: 'home_win' | 'draw' | 'away_win'
): { ft: string; ht: string } {
  // Use OWF as expected goals proxy, K1 as defensive proxy
  const expectedHomeGoals = Math.max(0, Math.round(owf * 1.2));
  const expectedAwayGoals = Math.max(0, Math.round((2 - k1) * 0.6));

  let home = expectedHomeGoals;
  let away = expectedAwayGoals;

  // Adjust based on predicted result
  if (primary === 'home_win') {
    home = Math.max(home, away + 1);
  } else if (primary === 'away_win') {
    away = Math.max(away, home + 1);
  } else {
    home = away; // Draw
  }

  // Clamp to reasonable range
  home = Math.min(home, 5);
  away = Math.min(away, 5);

  // Half-time: roughly 60% of full-time
  const htHome = Math.floor(home * 0.5);
  const htAway = Math.floor(away * 0.5);

  return {
    ft: `${home}:${away}`,
    ht: `${htHome}:${htAway}`,
  };
}

/**
 * Generate direction judgment text (telegram-style, 20-30 chars, no numbers).
 * SRS 1.2: Telegram style, noun stacking + qualitative adjectives
 */
export function generateDirectionJudgment(
  primary: 'home_win' | 'draw' | 'away_win',
  hedge: 'home_win' | 'draw' | 'away_win' | undefined,
  owf: number,
  k1: number,
  signals: MarketSignal[]
): string {
  const primaryText = primary === 'home_win' ? '胜' : primary === 'draw' ? '平' : '负';
  const hedgeText = hedge ? (hedge === 'home_win' ? '胜' : hedge === 'draw' ? '平' : '负') : '';

  // Build telegram-style direction
  const parts: string[] = [];

  // Market signal influence
  const hasSharpMove = signals.some(s => s.signalType === 'sharp_move');
  const hasSteamMove = signals.some(s => s.signalType === 'steam_move');

  if (owf > 1.5) {
    parts.push('进攻强势');
  } else if (owf < 0.5) {
    parts.push('进攻疲软');
  } else {
    parts.push('攻防均衡');
  }

  if (k1 > 1.5) {
    parts.push('防线脆弱');
  } else if (k1 < 0.5) {
    parts.push('防守稳固');
  }

  if (hasSharpMove) {
    parts.push('赔率异动');
  }

  // Result
  parts.push(`看好${primaryText}`);
  if (hedgeText && hedgeText !== primaryText) {
    parts.push(`谨防${hedgeText}`);
  }

  let result = parts.join(',');
  // Enforce 20-30 char limit
  if (result.length > 30) {
    result = result.substring(0, 30);
    // Ensure we don't cut in the middle of a character
    const lastComma = result.lastIndexOf(',');
    if (lastComma > 15) {
      result = result.substring(0, lastComma);
    }
  }
  if (result.length < 20) {
    result = parts.slice(0, 3).join(',') + ',看好' + primaryText;
  }

  // Remove any digits (constitutional constraint)
  result = result.replace(/[0-9]/g, '');

  return result;
}

/**
 * Assemble full LogicTrace for a prediction.
 */
export function assembleLogicTrace(
  facts: MatchFacts,
  weights: FactorWeights,
  evidence: EvidencePack,
  historicalErrorRate: number,
  marketSignals: MarketSignal[]
): { trace: LogicTrace; keyFactors: KeyFactorMap; owf: number; k1: number; wr: number; probabilities: ReturnType<typeof calibrateProbabilities> } {
  const mktSigAdj = marketSignals.reduce((sum, s) => {
    if (s.signalType === 'sharp_move') return sum + 0.04;
    if (s.signalType === 'steam_move') return sum - 0.04;
    return sum;
  }, 0);

  const formCtrAdj = facts.formationCtrHome - facts.formationCtrAway;

  const owfResult = calculateOWF(facts, weights, mktSigAdj, formCtrAdj);
  const k1Result = calculateK1(facts, weights);
  const wrResult = calculateWr(facts, weights, historicalErrorRate);

  // Bias zone correction
  const biasZoneAdj = facts.biasCorrection;

  const probabilities = calibrateProbabilities(
    owfResult.value,
    k1Result.value,
    wrResult.value,
    biasZoneAdj,
    mktSigAdj
  );

  // Merge key factors
  const keyFactors: KeyFactorMap = {
    ...owfResult.factors,
    ...k1Result.factors,
    ...wrResult.factors,
  };

  const trace: LogicTrace = {
    owf: owfResult.value,
    k1: k1Result.value,
    wr: wrResult.value,
    bayesianApplied: evidence.rawData.bayesianPriorApplied,
    unadjustedWarning: evidence.unadjustedWarning,
    probabilityCalibration: probabilities,
    formulaInputs: {
      xg_h_adj: facts.homeXgAdj,
      xg_a_adj: facts.awayXgAdj,
      conc_h_adj: facts.homeConcAdj,
      conc_a_adj: facts.awayConcAdj,
      w1: weights.w1,
      w2: weights.w2,
      w3: weights.w3,
      w4: weights.w4,
      weatherDecay: facts.weatherDecay,
      motivation: facts.motivationHome,
      injuryHome: facts.injuryImpactHome,
      refereeStrictness: facts.refereeStrictness,
    },
  };

  return { trace, keyFactors, owf: owfResult.value, k1: k1Result.value, wr: wrResult.value, probabilities };
}
