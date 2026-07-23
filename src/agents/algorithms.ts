// ============================================================
// CIAS - Bayesian Smoothing & De-Weighting Algorithm
// SRS 3.2.1: Opponent De-weighting with Bayesian Smoothing
// ============================================================

import { SYSTEM_CONSTANTS } from '../config/defaults';

/**
 * Calculate adjusted metric using Bayesian smoothing.
 *
 * SRS 3.2.1:
 *   Metric_adj = Metric_raw / SmoothedAvgRate
 *
 * If opponent has < 5 matches, use league average as prior (Bayesian smoothing).
 *
 * @param metricRaw     Raw metric value (e.g. xG, goals conceded)
 * @param oppMatches    Number of matches the opponent has played
 * @param oppAvgRate    Opponent's average rate (e.g. avg goals conceded per match)
 * @param leagueAvgRate League-wide average rate (prior)
 * @returns Adjusted metric and whether prior was applied
 */
export function bayesianSmooth(
  metricRaw: number,
  oppMatches: number,
  oppAvgRate: number,
  leagueAvgRate: number
): { adjusted: number; priorApplied: boolean } {
  const priorApplied = oppMatches < SYSTEM_CONSTANTS.BAYESIAN_MIN_SAMPLES;

  // If prior applied, blend opponent rate with league average
  // Using a simple Bayesian approach: posterior = (n * opp + priorWeight * league) / (n + priorWeight)
  const priorWeight = SYSTEM_CONSTANTS.BAYESIAN_MIN_SAMPLES; // Use min samples as prior weight
  let smoothedRate: number;

  if (priorApplied) {
    // When sample size < 5, shrink toward league average
    smoothedRate =
      (oppMatches * oppAvgRate + priorWeight * leagueAvgRate) /
      (oppMatches + priorWeight);
  } else {
    smoothedRate = oppAvgRate;
  }

  // Avoid division by zero
  if (smoothedRate === 0) {
    smoothedRate = leagueAvgRate;
  }

  const adjusted = metricRaw / smoothedRate;
  return { adjusted, priorApplied };
}

/**
 * Calculate xG adjusted for opponent strength.
 * @param teamXgRaw      Team's raw xG
 * @param oppMatches     Opponent's matches played
 * @param oppConcRate    Opponent's avg goals conceded per match
 * @param leagueAvgConc  League average goals conceded per match
 */
export function calculateAdjXg(
  teamXgRaw: number,
  oppMatches: number,
  oppConcRate: number,
  leagueAvgConc: number
): { xgAdj: number; priorApplied: boolean } {
  const { adjusted, priorApplied } = bayesianSmooth(
    teamXgRaw,
    oppMatches,
    oppConcRate,
    leagueAvgConc
  );
  return { xgAdj: adjusted, priorApplied };
}

/**
 * Calculate adjusted concession rate for opponent strength.
 * @param teamConcRaw    Team's raw goals conceded
 * @param oppMatches     Opponent's matches played
 * @param oppXgRate      Opponent's avg xG per match (attacking strength)
 * @param leagueAvgGoals League average goals per match
 */
export function calculateAdjConc(
  teamConcRaw: number,
  oppMatches: number,
  oppXgRate: number,
  leagueAvgGoals: number
): { concAdj: number; priorApplied: boolean } {
  const { adjusted, priorApplied } = bayesianSmooth(
    teamConcRaw,
    oppMatches,
    oppXgRate,
    leagueAvgGoals
  );
  return { concAdj: adjusted, priorApplied };
}

/**
 * Get weather decay factor based on weather conditions.
 * SRS: W_th ranges 0.95 to 1.0 (extreme weather reduces scoring)
 */
export function calculateWeatherDecay(
  temperature: number,
  windSpeed: number,
  precipitation: number,
  isExtremeWeather: boolean
): number {
  if (!isExtremeWeather) return 1.0;

  let decay = 1.0;

  // Heavy rain/snow reduces xG
  if (precipitation > 10) {
    decay -= 0.02 * Math.min(precipitation / 10, 3);
  }

  // High wind reduces accuracy
  if (windSpeed > 20) {
    decay -= 0.01 * Math.min(windSpeed / 20, 3);
  }

  // Extreme cold/heat
  if (temperature < 0 || temperature > 35) {
    decay -= 0.01;
  }

  // Clamp to [0.95, 1.0]
  return Math.max(0.95, Math.min(1.0, decay));
}

/**
 * Calculate referee strictness bonus.
 * SRS: Ref_st adds +0.02 per level to Wr (risk weight)
 */
export function calculateRefereeStrictness(
  yellowCardAvg: number,
  redCardAvg: number,
  foulsPerGame: number
): number {
  // Base: normalize card rates to a 1-5 scale
  const cardScore = Math.min(5, (yellowCardAvg * 0.5 + redCardAvg * 2) / 1);
  const foulScore = Math.min(5, foulsPerGame / 5);
  const avgScore = (cardScore + foulScore) / 2;
  return avgScore * 0.02; // +0.02 per level
}

/**
 * Calculate motivation coefficient.
 * SRS: Motiv ranges 0.9 to 1.1
 */
export function calculateMotivation(
  isDerby: boolean,
  isTitleDecider: boolean,
  isRelegationBattle: boolean,
  isDeadRubber: boolean,
  homeAdvantage: boolean
): number {
  let motiv = 1.0;

  if (isDerby) motiv += 0.05;
  if (isTitleDecider) motiv += 0.1;
  if (isRelegationBattle) motiv += 0.08;
  if (isDeadRubber) motiv -= 0.1;
  if (homeAdvantage) motiv += 0.02;

  // Clamp to [0.9, 1.1]
  return Math.max(0.9, Math.min(1.1, motiv));
}

/**
 * Calculate injury impact.
 * SRS F5/F6: Injury impact on OWF/K1
 */
export function calculateInjuryImpact(
  injuredPlayers: { position: 'GK' | 'DEF' | 'MID' | 'FWD'; importance: number }[],
  isHome: boolean
): number {
  let impact = 0;
  const positionWeights = { GK: 1.0, DEF: 0.7, MID: 0.5, FWD: 0.3 };
  for (const p of injuredPlayers) {
    impact += positionWeights[p.position] * p.importance;
  }
  // Normalize: impact as fraction of maximum possible (e.g. all key players injured)
  const maxImpact = 5 * 1.0; // 5 key players
  const normalized = Math.min(1, impact / maxImpact);

  // Impact on scoring: reduces OWF
  // Impact on defense: increases K1 vulnerability
  return normalized * (isHome ? 0.15 : 0.15); // w5/w6 = 0.15
}

/**
 * Calculate formation counter effect.
 * SRS F13: Form_ctr ranges -0.03 to +0.03
 */
export function calculateFormationCounter(
  homeFormation: string,
  awayFormation: string
): number {
  // Simplified rock-paper-scissors:
  // 433 > 442 > 532 > 433 (circular)
  const counters: Record<string, string> = {
    '4-3-3': '4-4-2',
    '4-4-2': '5-3-2',
    '5-3-2': '4-3-3',
  };

  if (counters[homeFormation] === awayFormation) return 0.03;
  if (counters[awayFormation] === homeFormation) return -0.03;
  return 0;
}
