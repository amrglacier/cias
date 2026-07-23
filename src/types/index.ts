// ============================================================
// CIAS - Core Type Definitions
// Based on SRS V1.4.2 Section 3.1 (Prediction Factors) & Section 7 (Data Architecture)
// ============================================================

// --- Factor IDs (F1-F13) ---
export type FactorId =
  | 'F1'  // xG_h_adj
  | 'F2'  // xG_a_adj
  | 'F3'  // Conc_h_adj
  | 'F4'  // Conc_a_adj
  | 'F5'  // Inj_h
  | 'F6'  // Inj_a
  | 'F7'  // W_th
  | 'F8'  // Ref_st
  | 'F9'  // Motiv
  | 'F10' // Bias_zone
  | 'F11' // Mkt_sig
  | 'F12' // Err_rate
  | 'F13' // Form_ctr;

// --- Factor Definition ---
export interface FactorDefinition {
  id: FactorId;
  name: string;
  symbol: string;
  agent: 'data' | 'logic';
  affects: 'OWF' | 'K1' | 'Wr' | 'OWFxK1' | 'probability_calibration' | 'OWF_micro' | 'Wr_base';
  initialWeight: number;
  weightRange?: { min: number; max: number };
}

export const FACTOR_REGISTRY: Record<FactorId, FactorDefinition> = {
  F1:  { id: 'F1',  name: 'Home Adjusted xG',        symbol: 'xG_h_adj',  agent: 'data', affects: 'OWF',           initialWeight: 0.35 },
  F2:  { id: 'F2',  name: 'Away Adjusted xG',        symbol: 'xG_a_adj',  agent: 'data', affects: 'OWF',           initialWeight: 0.25 },
  F3:  { id: 'F3',  name: 'Home Adjusted Concession', symbol: 'Conc_h_adj', agent: 'data', affects: 'K1',          initialWeight: 0.20 },
  F4:  { id: 'F4',  name: 'Away Adjusted Concession', symbol: 'Conc_a_adj', agent: 'data', affects: 'K1',          initialWeight: 0.10 },
  F5:  { id: 'F5',  name: 'Injury Impact (Home)',     symbol: 'Inj_h',     agent: 'data', affects: 'OWF',           initialWeight: 0.15 },
  F6:  { id: 'F6',  name: 'Injury Impact (Away)',     symbol: 'Inj_a',     agent: 'data', affects: 'K1',            initialWeight: 0.15 },
  F7:  { id: 'F7',  name: 'Weather Decay',           symbol: 'W_th',      agent: 'data', affects: 'OWFxK1',        initialWeight: 0.95, weightRange: { min: 0.95, max: 1.0 } },
  F8:  { id: 'F8',  name: 'Referee Strictness',      symbol: 'Ref_st',    agent: 'data', affects: 'Wr',            initialWeight: 0.02 },
  F9:  { id: 'F9',  name: 'Motivation Coefficient',   symbol: 'Motiv',    agent: 'data', affects: 'OWF',           initialWeight: 1.0,  weightRange: { min: 0.9, max: 1.1 } },
  F10: { id: 'F10', name: 'Odds Zone Bias',           symbol: 'Bias_zone', agent: 'data', affects: 'probability_calibration', initialWeight: 0, weightRange: { min: -0.05, max: 0.03 } },
  F11: { id: 'F11', name: 'Sharp/Steam Signal',       symbol: 'Mkt_sig',  agent: 'data', affects: 'OWF_micro',     initialWeight: 0,    weightRange: { min: -0.04, max: 0.04 } },
  F12: { id: 'F12', name: 'Historical Error Rate',     symbol: 'Err_rate', agent: 'data', affects: 'Wr',            initialWeight: 0.05 },
  F13: { id: 'F13', name: 'Formation Counter',        symbol: 'Form_ctr', agent: 'data', affects: 'OWF_micro',     initialWeight: 0,    weightRange: { min: -0.03, max: 0.03 } },
};

// --- Evidence Pack (Data Agent output) ---
export interface EvidencePack {
  matchId: string;
  factors: Partial<Record<FactorId, number>>;
  rawData: {
    homeXgRaw?: number;
    awayXgRaw?: number;
    homeConcRaw?: number;
    awayConcRaw?: number;
    homeMatchesPlayed?: number;
    awayMatchesPlayed?: number;
    leagueAvgGoals: number;
    leagueAvgConc: number;
    bayesianPriorApplied: boolean;
  };
  confidence: number; // 0-1
  unadjustedWarning: boolean; // true if *_adj not provided
  collectedAt: string; // ISO timestamp
  notes: string[];
}

// --- Market Signal ---
export interface MarketSignal {
  id: string;
  matchId: string;
  signalType: 'sharp_move' | 'steam_move' | 'odds_shift' | 'death_odds';
  description: string;
  oddsSnapshotId?: number;
  detectedAt: string;
  metadata: {
    movePctHome?: number;
    movePctDraw?: number;
    movePctAway?: number;
    oddsZone?: string;
    [key: string]: unknown;
  };
}

// --- Odds Snapshot ---
export interface OddsSnapshot {
  id?: number;
  matchId: string;
  capturedAt: string;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  source: string;
  prevHomeOdds?: number;
  prevDrawOdds?: number;
  prevAwayOdds?: number;
  movePctHome?: number;
  movePctDraw?: number;
  movePctAway?: number;
  signalType?: string;
  isSharpMove?: boolean;
  isSteamMove?: boolean;
}

// --- Match Facts (DB row) ---
export interface MatchFacts {
  matchId: string;
  homeXgAdj?: number;
  awayXgAdj?: number;
  homeConcAdj?: number;
  awayConcAdj?: number;
  injuryImpactHome: number;
  injuryImpactAway: number;
  weatherDecay: number;
  refereeStrictness: number;
  motivationHome: number;
  motivationAway: number;
  oddsZone?: string;
  biasCorrection: number;
  formationCtrHome: number;
  formationCtrAway: number;
  dataConfidence: number;
  leagueAvgGoals: number;
  leagueAvgConc: number;
  bayesianPriorApplied: boolean;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

// --- Prediction Result ---
export type MatchResult = 'home_win' | 'draw' | 'away_win';
export type VersionTag = 'INITIAL' | 'PERIODIC' | 'FINAL';
export type AlignmentStatus = 'aligned' | 'forced_degrade' | 'pending' | 'disputed';

export interface Prediction {
  id?: number;
  matchId: string;
  primaryResult: MatchResult;
  primaryFt: string;       // e.g. "2:1"
  primaryHt?: string;      // e.g. "1:0"
  hedgeResult?: MatchResult;
  hedgeFt?: string;
  hedgeHt?: string;
  directionJudgment: string; // Telegram-style, 20-30 chars, no numbers
  versionTag: VersionTag;
  isArchived: boolean;
  snapshotId?: number;
  prevVersionId?: number;
  marketSignalIds: string[];
  deltaExplanation?: string;
  logicTrace: LogicTrace;
  keyFactors: KeyFactorMap;
  isLock: boolean;
  alignmentStatus: AlignmentStatus;
  alignmentForcedDegrade: boolean;
  crossDiscussionLog: CrossDiscussionEntry[];
  createdAt?: string;
}

// --- Logic Trace ---
export interface LogicTrace {
  owf?: number;           // Offensive Weighted Factor
  k1?: number;            // Defensive Factor
  wr?: number;            // Risk Weight
  bayesianApplied: boolean;
  unadjustedWarning: boolean;
  probabilityCalibration?: {
    homeWinProb: number;
    drawProb: number;
    awayWinProb: number;
    biasZoneAdj: number;
    mktSigAdj: number;
  };
  formulaInputs?: {
    xg_h_adj?: number;
    xg_a_adj?: number;
    conc_h_adj?: number;
    conc_a_adj?: number;
    w1: number;
    w2: number;
    w3: number;
    w4: number;
    weatherDecay: number;
    motivation: number;
    injuryHome: number;
    refereeStrictness: number;
  };
}

// --- Key Factors (JSONB in predictions) ---
export interface KeyFactorMap {
  [factorId: string]: {
    value: number;
    weight: number;
    contribution: number;
    note: string;
  };
}

// --- Cross-Discussion Entry ---
export interface CrossDiscussionEntry {
  round: number;
  speaker: 'system' | 'data' | 'logic';
  message: string;
  action?: 'modify_param' | 'quantify_dismiss' | 'forced_degrade' | 'accepted';
  modifiedFactor?: FactorId;
  oldValue?: number;
  newValue?: number;
  timestamp: string;
}

// --- API Usage (for circuit breaker) ---
export interface ApiUsage {
  apiName: string;
  endpoint?: string;
  remaining?: number;
  total?: number;
  used?: number;
  calledAt: string;
}

// --- Review Result ---
export type AttributionCode = 'A1' | 'A2' | 'C1' | 'C2' | 'D1' | 'D2' | 'D3' | 'D4';

export interface ReviewResult {
  id?: number;
  matchId: string;
  predictionId: number;
  actualResult: MatchResult;
  actualFt?: string;
  actualHt?: string;
  attributionCode: AttributionCode;
  attributionParty: 'data' | 'logic';
  attributionDetail: string;
  errorType: string;
  isUpset: boolean;
  createdAt?: string;
}

// --- Weight Adjustment Record ---
export interface WeightAdjustment {
  id?: number;
  factorId: string;
  factorName: string;
  oldWeight: number;
  newWeight: number;
  adjustmentPct: number;
  triggerReason: string;
  matchCount: number;
  createdAt?: string;
}

// --- Factor Weights (persisted in system_config) ---
export interface FactorWeights {
  w1: number;  // 0.35
  w2: number;  // 0.25
  w3: number;  // 0.20
  w4: number;  // 0.10
  inj_home: number;   // 0.15
  inj_away: number;   // 0.15
  weather_decay_min: number;  // 0.95
  weather_decay_max: number;  // 1.0
  ref_strictness_step: number; // 0.02
  motiv_min: number;   // 0.9
  motiv_max: number;   // 1.1
  bias_zone_min: number;  // -0.05
  bias_zone_max: number;  // 0.03
  mkt_sig_range: number;  // 0.04
  form_ctr_range: number; // 0.03
}

// --- Constitutional Check Result ---
export interface ConstitutionalCheck {
  passed: boolean;
  violations: string[];
  checks: {
    formatValid: boolean;
    directionLengthValid: boolean;
    noNumbersInDirection: boolean;
    hedgePresent: boolean;
    versionTagValid: boolean;
  };
}

// --- Circuit Breaker State ---
export interface CircuitBreakerState {
  apiBudgetRemaining: number; // percentage 0-100
  isTripped: boolean;
  tFusePassed: boolean;
  nonCoreRequestsBlocked: boolean;
}

// --- Worker Environment ---
export interface Env {
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  // API-Football
  API_FOOTBALL_KEY: string;
  API_FOOTBALL_BASE_URL?: string;
  // LLM
  LLM_API_KEY: string;
  LLM_API_BASE?: string;
  LLM_MODEL?: string;
  // Odds API
  ODDS_API_KEY: string;
  ODDS_API_BASE_URL?: string;
  // Notification
  NOTIFY_WEBHOOK_URL?: string;
  // Cloudflare
  CLOUDFLARE_ACCOUNT_ID?: string;
  // KV Namespace for locks
  CIAS_LOCKS: KVNamespace;
  // Durable Object
  CONCURRENCY_LOCK: DurableObjectNamespace;
  // Environment vars (from [vars])
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  MATCH_WINDOW_PRE_HOURS: string;
  MATCH_WINDOW_FUSE_MINUTES: string;
  API_BUDGET_CRITICAL_PERCENT: string;
  INPLAY_MAX_RECORDS: string;
  CROSS_DISCUSSION_MAX_ROUNDS: string;
  REVIEW_HITRATE_THRESHOLD: string;
  REVIEW_TREND_ERROR_COUNT: string;
  REVIEW_ADJUSTMENT_MAX_PERCENT: string;
}

// --- SOP Phase ---
export type SopPhase = 'T0' | 'INITIAL' | 'CROSS_DISCUSSION' | 'PERIODIC' | 'FUSE' | 'REVIEW';

// --- Match Info ---
export interface MatchInfo {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoffTime: string; // ISO
  status: 'scheduled' | 'in_play' | 'finished';
  homeScore?: number;
  awayScore?: number;
  halftimeHomeScore?: number;
  halftimeAwayScore?: number;
}
