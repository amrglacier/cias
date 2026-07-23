// ============================================================
// CIAS - Default Configuration
// Based on SRS V1.4.2
// ============================================================

export const DEFAULT_FACTOR_WEIGHTS = {
  w1: 0.35,
  w2: 0.25,
  w3: 0.20,
  w4: 0.10,
  inj_home: 0.15,
  inj_away: 0.15,
  weather_decay_min: 0.95,
  weather_decay_max: 1.0,
  ref_strictness_step: 0.02,
  motiv_min: 0.9,
  motiv_max: 1.1,
  bias_zone_min: -0.05,
  bias_zone_max: 0.03,
  mkt_sig_range: 0.04,
  form_ctr_range: 0.03,
} as const;

export const SYSTEM_CONSTANTS = {
  // Constitutional constraints
  DIRECTION_MIN_CHARS: 20,
  DIRECTION_MAX_CHARS: 30,

  // In-play window
  INPLAY_MAX_RECORDS: 5,

  // Cross-discussion
  CROSS_DISCUSSION_MAX_ROUNDS: 2,

  // Market signal thresholds
  SHARP_MOVE_THRESHOLD: 0.05,  // >=5% move
  STEAM_MOVE_THRESHOLD: 0.08,  // >=8% rapid move

  // Bayesian smoothing
  BAYESIAN_MIN_SAMPLES: 5,

  // Circuit breaker
  API_BUDGET_CRITICAL_PERCENT: 10,

  // Review system
  REVIEW_HITRATE_THRESHOLD: 30,
  REVIEW_TREND_ERROR_COUNT: 3,
  REVIEW_ADJUSTMENT_MAX_PCT: 10,

  // Prediction defaults
  DEFAULT_DATA_CONFIDENCE: 0.5,

  // Atomic cleanup
  CLEANUP_OLDEST_LIMIT: 1,
} as const;

// Odds zone classification (death odds /民俗知识标注)
export const ODDS_ZONES = {
  DEATH_ODDS: 'death_odds',      // e.g. 1.44 (special bias zone)
  STRONG_FAVORITE: 'strong_favorite',  // < 1.5
  FAVORITE: 'favorite',           // 1.5 - 1.8
  BALANCED: 'balanced',          // 1.8 - 2.5
  UNDERDOG: 'underdog',          // 2.5 - 3.5
  BIG_UNDERDOG: 'big_underdog',  // > 3.5
} as const;

// Death odds specific values (民俗知识)
export const DEATH_ODDS_VALUES = [1.44, 2.22, 3.33];

export function classifyOddsZone(homeOdds: number): string {
  if (DEATH_ODDS_VALUES.some(v => Math.abs(homeOdds - v) < 0.02)) {
    return ODDS_ZONES.DEATH_ODDS;
  }
  if (homeOdds < 1.5) return ODDS_ZONES.STRONG_FAVORITE;
  if (homeOdds < 1.8) return ODDS_ZONES.FAVORITE;
  if (homeOdds < 2.5) return ODDS_ZONES.BALANCED;
  if (homeOdds < 3.5) return ODDS_ZONES.UNDERDOG;
  return ODDS_ZONES.BIG_UNDERDOG;
}

// Sharp/Steam move detection
export function detectMoveType(
  prevOdds: number,
  currOdds: number
): { isSharp: boolean; isSteam: boolean; movePct: number } {
  if (prevOdds <= 0) return { isSharp: false, isSteam: false, movePct: 0 };
  const movePct = Math.abs(currOdds - prevOdds) / prevOdds;
  return {
    isSharp: movePct >= SYSTEM_CONSTANTS.SHARP_MOVE_THRESHOLD,
    isSteam: movePct >= SYSTEM_CONSTANTS.STEAM_MOVE_THRESHOLD,
    movePct,
  };
}
