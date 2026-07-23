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

// ============================================================
// Betting Window Config (configurable via system_config)
// ============================================================
export interface BettingWindowConfig {
  start_hours_before_kickoff: number;
  end_minutes_before_kickoff: number;
  fundamentals_delay_after_start_hours: number;
  final_lock_minutes_before_end: number;
  daily_active_start: string;
  daily_active_end: string;
  timezone: string;
  target_leagues: string[];
  api_football_league_ids: number[];
  season: string;
}

export const DEFAULT_BETTING_WINDOW_CONFIG: BettingWindowConfig = {
  start_hours_before_kickoff: 2,
  end_minutes_before_kickoff: 15,
  fundamentals_delay_after_start_hours: 0.5,
  final_lock_minutes_before_end: 15,
  daily_active_start: '06:00',
  daily_active_end: '23:59',
  timezone: 'Asia/Shanghai',
  target_leagues: ['soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one'],
  api_football_league_ids: [39, 140, 135, 78, 61],
  season: '2025',
};

/**
 * Get betting window config from system_config (DB) with fallback to defaults.
 */
export function mergeBettingWindowConfig(dbValue: unknown): BettingWindowConfig {
  if (!dbValue || typeof dbValue !== 'object') {
    return { ...DEFAULT_BETTING_WINDOW_CONFIG };
  }
  const obj = dbValue as Record<string, unknown>;
  return {
    start_hours_before_kickoff: typeof obj.start_hours_before_kickoff === 'number' ? obj.start_hours_before_kickoff : DEFAULT_BETTING_WINDOW_CONFIG.start_hours_before_kickoff,
    end_minutes_before_kickoff: typeof obj.end_minutes_before_kickoff === 'number' ? obj.end_minutes_before_kickoff : DEFAULT_BETTING_WINDOW_CONFIG.end_minutes_before_kickoff,
    fundamentals_delay_after_start_hours: typeof obj.fundamentals_delay_after_start_hours === 'number' ? obj.fundamentals_delay_after_start_hours : DEFAULT_BETTING_WINDOW_CONFIG.fundamentals_delay_after_start_hours,
    final_lock_minutes_before_end: typeof obj.final_lock_minutes_before_end === 'number' ? obj.final_lock_minutes_before_end : DEFAULT_BETTING_WINDOW_CONFIG.final_lock_minutes_before_end,
    daily_active_start: typeof obj.daily_active_start === 'string' ? obj.daily_active_start : DEFAULT_BETTING_WINDOW_CONFIG.daily_active_start,
    daily_active_end: typeof obj.daily_active_end === 'string' ? obj.daily_active_end : DEFAULT_BETTING_WINDOW_CONFIG.daily_active_end,
    timezone: typeof obj.timezone === 'string' ? obj.timezone : DEFAULT_BETTING_WINDOW_CONFIG.timezone,
    target_leagues: Array.isArray(obj.target_leagues) ? obj.target_leagues as string[] : DEFAULT_BETTING_WINDOW_CONFIG.target_leagues,
    api_football_league_ids: Array.isArray(obj.api_football_league_ids) ? obj.api_football_league_ids as number[] : DEFAULT_BETTING_WINDOW_CONFIG.api_football_league_ids,
    season: typeof obj.season === 'string' ? obj.season : DEFAULT_BETTING_WINDOW_CONFIG.season,
  };
}

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
