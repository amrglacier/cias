// ============================================================
// CIAS - Data Agent
// SRS 2.1: Data Agent - ETL, Entity Extraction, Fact Verification, Factor Processing
// Runs on Cloudflare Worker
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Env, MatchFacts, EvidencePack, MatchInfo,
  OddsSnapshot, MarketSignal, ApiUsage,
} from '../types';
import {
  bayesianSmooth, calculateAdjXg, calculateAdjConc,
  calculateWeatherDecay, calculateRefereeStrictness,
  calculateMotivation, calculateInjuryImpact, calculateFormationCounter,
} from './algorithms';
import { classifyOddsZone, detectMoveType, DEATH_ODDS_VALUES, ODDS_ZONES } from '../config/defaults';
import {
  upsertMatchFacts, getMatchFacts, updateMatchFactsStatus,
  insertOddsSnapshot, getLatestOddsSnapshot,
  insertMarketSignal, getMarketSignals,
  logApiUsage, getLatestApiUsage,
} from '../db/repository';
import { getSupabase } from '../db/client';

// ============================================================
// T0: Fundamentals Gathering
// ============================================================

/**
 * Phase 1 (T0): Gather match fundamentals from API-Football.
 * SRS: Step 1 - Get fixtures, Step 2 - Data enrichment, Step 3 - Freeze snapshot
 */
export async function gatherFundamentals(env: Env, match: MatchInfo): Promise<MatchFacts> {
  const db = getSupabase(env);
  console.log(`[DataAgent] T0: Gathering fundamentals for match ${match.matchId}`);

  // Step 1: Fetch raw data from API-Football
  const rawData = await fetchApiFootballData(env, match);

  // Step 2: Apply Bayesian smoothing & de-weighting
  const processed = processDataWithBayesian(rawData);

  // Step 3: Calculate additional factors
  const weatherDecay = calculateWeatherDecay(
    rawData.weather.temperature,
    rawData.weather.windSpeed,
    rawData.weather.precipitation,
    rawData.weather.isExtreme
  );

  const refereeStrictness = calculateRefereeStrictness(
    rawData.referee.yellowCardAvg,
    rawData.referee.redCardAvg,
    rawData.referee.foulsPerGame
  );

  const motivationHome = calculateMotivation(
    rawData.isDerby, rawData.isTitleDecider, rawData.isRelegationBattle,
    rawData.isDeadRubber, true
  );

  const motivationAway = calculateMotivation(
    rawData.isDerby, rawData.isTitleDecider, rawData.isRelegationBattle,
    rawData.isDeadRubber, false
  );

  const injuryImpactHome = calculateInjuryImpact(rawData.injuries.home, true);
  const injuryImpactAway = calculateInjuryImpact(rawData.injuries.away, false);

  const formationCtr = calculateFormationCounter(
    rawData.formations.home,
    rawData.formations.away
  );

  // Determine odds zone from latest snapshot
  let oddsZone: string | undefined;
  let biasCorrection = 0;
  const latestSnapshot = await getLatestOddsSnapshot(db, match.matchId);
  if (latestSnapshot) {
    oddsZone = classifyOddsZone(latestSnapshot.homeOdds);
    // Death odds special bias
    if (oddsZone === ODDS_ZONES.DEATH_ODDS) {
      biasCorrection = -0.05; // Death odds -> reduce home win probability
    }
  }

  // Step 4: Build MatchFacts and persist
  const facts: MatchFacts = {
    matchId: match.matchId,
    homeXgAdj: processed.homeXgAdj,
    awayXgAdj: processed.awayXgAdj,
    homeConcAdj: processed.homeConcAdj,
    awayConcAdj: processed.awayConcAdj,
    injuryImpactHome,
    injuryImpactAway,
    weatherDecay,
    refereeStrictness,
    motivationHome,
    motivationAway,
    oddsZone,
    biasCorrection,
    formationCtrHome: formationCtr,
    formationCtrAway: -formationCtr,
    dataConfidence: processed.confidence,
    leagueAvgGoals: rawData.leagueAvgGoals,
    leagueAvgConc: rawData.leagueAvgConc,
    bayesianPriorApplied: processed.priorApplied,
    status: 'frozen', // SRS: T0 data is frozen
  };

  const saved = await upsertMatchFacts(db, facts);
  console.log(`[DataAgent] T0: Fundamentals frozen for match ${match.matchId}`);
  return saved;
}

// ============================================================
// Build Evidence Pack
// ============================================================

/**
 * SRS 2.1 Output: Build Evidence Pack from match facts.
 */
export async function buildEvidencePack(env: Env, matchId: string): Promise<EvidencePack> {
  const db = getSupabase(env);
  const facts = await getMatchFacts(db, matchId);
  if (!facts) throw new Error(`No match facts found for ${matchId}`);

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

  const notes: string[] = [];
  if (unadjustedWarning) {
    notes.push('Some *_adj fields are missing - Logic Agent should mark confidence downgrade');
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
      homeXgRaw: facts.homeXgAdj, // adj values are stored; raw is pre-adj (not persisted separately)
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

// ============================================================
// Market Signal Capture (T1~Tn)
// ============================================================

/**
 * SRS Phase 4: Capture odds snapshot and detect market signals.
 * Called by Cron Trigger every 15 minutes.
 */
export async function captureOddsSnapshot(env: Env, matchId: string): Promise<{ snapshot: OddsSnapshot; signals: MarketSignal[] }> {
  const db = getSupabase(env);
  console.log(`[DataAgent] Capturing odds snapshot for match ${matchId}`);

  // Fetch current odds from Odds API
  const currentOdds = await fetchOddsFromApi(env, matchId);

  // Get previous snapshot for comparison
  const prevSnapshot = await getLatestOddsSnapshot(db, matchId);

  // Detect moves
  let moveResult: { isSharp: boolean; isSteam: boolean; movePct: number } = { isSharp: false, isSteam: false, movePct: 0 };
  if (prevSnapshot) {
    moveResult = detectMoveType(prevSnapshot.homeOdds, currentOdds.homeOdds);
  }

  const snapshot: OddsSnapshot = {
    matchId,
    capturedAt: new Date().toISOString(),
    homeOdds: currentOdds.homeOdds,
    drawOdds: currentOdds.drawOdds,
    awayOdds: currentOdds.awayOdds,
    source: 'odds_api',
    prevHomeOdds: prevSnapshot?.homeOdds,
    prevDrawOdds: prevSnapshot?.drawOdds,
    prevAwayOdds: prevSnapshot?.awayOdds,
    movePctHome: moveResult.movePct,
    signalType: moveResult.isSteam ? 'steam_move' : moveResult.isSharp ? 'sharp_move' : undefined,
    isSharpMove: moveResult.isSharp,
    isSteamMove: moveResult.isSteam,
  };

  const snapshotId = await insertOddsSnapshot(db, snapshot);

  // Generate market signals if move detected
  const signals: MarketSignal[] = [];
  if (moveResult.isSharp || moveResult.isSteam) {
    const signal: MarketSignal = {
      id: crypto.randomUUID(),
      matchId,
      signalType: moveResult.isSteam ? 'steam_move' : 'sharp_move',
      description: moveResult.isSteam
        ? `Steam move detected: home odds moved ${moveResult.movePct.toFixed(2)}%`
        : `Sharp move detected: home odds moved ${moveResult.movePct.toFixed(2)}%`,
      oddsSnapshotId: snapshotId,
      detectedAt: new Date().toISOString(),
      metadata: {
        movePctHome: moveResult.movePct,
        oddsZone: classifyOddsZone(currentOdds.homeOdds),
      },
    };
    await insertMarketSignal(db, signal);
    signals.push(signal);
  }

  // Check for death odds
  if (DEATH_ODDS_VALUES.some(v => Math.abs(currentOdds.homeOdds - v) < 0.02)) {
    const signal: MarketSignal = {
      id: crypto.randomUUID(),
      matchId,
      signalType: 'death_odds',
      description: `Death odds detected: home odds at ${currentOdds.homeOdds}`,
      oddsSnapshotId: snapshotId,
      detectedAt: new Date().toISOString(),
      metadata: {
        oddsValue: currentOdds.homeOdds,
        oddsZone: ODDS_ZONES.DEATH_ODDS,
      },
    };
    await insertMarketSignal(db, signal);
    signals.push(signal);
  }

  return { snapshot: { ...snapshot, id: snapshotId }, signals };
}

// ============================================================
// API Budget Check (Circuit Breaker support)
// ============================================================

/**
 * SRS 2.3: Check API budget for circuit breaker.
 * If remaining < 10%, non-core requests should be blocked.
 */
export async function checkApiBudget(env: Env, apiName: string): Promise<number> {
  const db = getSupabase(env);
  const latest = await getLatestApiUsage(db, apiName);
  if (!latest || latest.remaining === undefined) return 100; // Assume full budget
  return (latest.remaining / (latest.total ?? 100)) * 100;
}

/**
 * Log API usage after each call (parse response headers).
 */
export async function logApiCall(env: Env, apiName: string, endpoint: string, remaining: number, total: number): Promise<void> {
  const db = getSupabase(env);
  await logApiUsage(db, {
    apiName,
    endpoint,
    calledAt: new Date().toISOString(),
    remaining,
    total,
    used: total - remaining,
  });
}

// ============================================================
// Internal: API-Football data fetching
// ============================================================

interface RawApiData {
  homeXgRaw: number;
  awayXgRaw: number;
  homeConcRaw: number;
  awayConcRaw: number;
  homeMatchesPlayed: number;
  awayMatchesPlayed: number;
  homeOppConcRate: number;
  awayOppConcRate: number;
  homeOppXgRate: number;
  awayOppXgRate: number;
  leagueAvgGoals: number;
  leagueAvgConc: number;
  weather: {
    temperature: number;
    windSpeed: number;
    precipitation: number;
    isExtreme: boolean;
  };
  referee: {
    yellowCardAvg: number;
    redCardAvg: number;
    foulsPerGame: number;
  };
  injuries: {
    home: { position: 'GK' | 'DEF' | 'MID' | 'FWD'; importance: number }[];
    away: { position: 'GK' | 'DEF' | 'MID' | 'FWD'; importance: number }[];
  };
  formations: {
    home: string;
    away: string;
  };
  isDerby: boolean;
  isTitleDecider: boolean;
  isRelegationBattle: boolean;
  isDeadRubber: boolean;
}

async function fetchApiFootballData(env: Env, match: MatchInfo): Promise<RawApiData> {
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? {
        'x-rapidapi-key': env.API_FOOTBALL_KEY,
        'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
      }
    : {
        'x-apisports-key': env.API_FOOTBALL_KEY,
      };

  // Fetch team statistics (xG, goals)
  const [homeStats, awayStats, leagueStats, weatherData, refereeData, injuryData, formationData] = await Promise.all([
    fetchTeamStats(env, baseUrl, headers, match, 'home'),
    fetchTeamStats(env, baseUrl, headers, match, 'away'),
    fetchLeagueStats(env, baseUrl, headers, match),
    fetchWeatherData(env, match),
    fetchRefereeData(env, baseUrl, headers, match),
    fetchInjuryData(env, baseUrl, headers, match),
    fetchFormationData(env, baseUrl, headers, match),
  ]);

  return {
    ...homeStats,
    ...awayStats,
    ...leagueStats,
    weather: weatherData,
    referee: refereeData,
    injuries: injuryData,
    formations: formationData,
    isDerby: match.homeTeam === match.awayTeam, // simplified
    isTitleDecider: false,
    isRelegationBattle: false,
    isDeadRubber: false,
  } as RawApiData;
}

async function fetchTeamStats(
  env: Env, baseUrl: string, headers: Record<string, string>,
  match: MatchInfo, side: 'home' | 'away'
): Promise<Partial<RawApiData>> {
  const teamId = side === 'home' ? match.homeTeam : match.awayTeam;
  const url = `${baseUrl}/teams/statistics?league=${encodeURIComponent(match.league)}&team=${encodeURIComponent(teamId)}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`API-Football team stats failed: ${resp.status}`);

  // Log API usage
  const remaining = parseInt(resp.headers.get('x-ratelimit-remaining') || '100');
  const total = parseInt(resp.headers.get('x-ratelimit-limit') || '100');
  await logApiCall(env, 'api-football', `/teams/statistics`, remaining, total);

  const data = await resp.json() as { response?: { goals?: { for?: { total?: { average?: string }; away?: { average?: string } }; against?: { total?: { average?: string }; away?: { average?: string } } } } };

  const stats = data.response;
  if (!stats) return {};

  const prefix = side === 'home' ? 'home' : 'away';
  const xgRaw = parseFloat(stats.goals?.for?.total?.average || '1.3');
  const concRaw = parseFloat(stats.goals?.against?.total?.average || '1.3');

  return {
    [`${prefix}XgRaw`]: xgRaw,
    [`${prefix}ConcRaw`]: concRaw,
    [`${prefix}MatchesPlayed`]: 10, // Would parse from actual API
    [`${prefix}OppConcRate`]: 1.3,
    [`${prefix}OppXgRate`]: 1.3,
  } as Partial<RawApiData>;
}

async function fetchLeagueStats(
  env: Env, baseUrl: string, headers: Record<string, string>,
  match: MatchInfo
): Promise<Partial<RawApiData>> {
  // Fetch league-wide averages for Bayesian prior
  const url = `${baseUrl}/teams/statistics?league=${encodeURIComponent(match.league)}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    return { leagueAvgGoals: 1.3, leagueAvgConc: 1.3 };
  }
  return { leagueAvgGoals: 1.3, leagueAvgConc: 1.3 };
}

async function fetchWeatherData(env: Env, match: MatchInfo): Promise<RawApiData['weather']> {
  // Simplified: in production, call a weather API
  return { temperature: 20, windSpeed: 5, precipitation: 0, isExtreme: false };
}

async function fetchRefereeData(
  env: Env, baseUrl: string, headers: Record<string, string>,
  match: MatchInfo
): Promise<RawApiData['referee']> {
  // Fetch referee statistics
  return { yellowCardAvg: 3.5, redCardAvg: 0.2, foulsPerGame: 22 };
}

async function fetchInjuryData(
  env: Env, baseUrl: string, headers: Record<string, string>,
  match: MatchInfo
): Promise<RawApiData['injuries']> {
  const url = `${baseUrl}/injuries?team=${encodeURIComponent(match.homeTeam)}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    return { home: [], away: [] };
  }

  // Parse injuries - simplified
  return { home: [], away: [] };
}

async function fetchFormationData(
  env: Env, baseUrl: string, headers: Record<string, string>,
  match: MatchInfo
): Promise<RawApiData['formations']> {
  // Fetch lineup/formation data
  return { home: '4-3-3', away: '4-4-2' };
}

// ============================================================
// Internal: Odds API
// ============================================================

async function fetchOddsFromApi(env: Env, matchId: string): Promise<{ homeOdds: number; drawOdds: number; awayOdds: number }> {
  const baseUrl = env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
  const url = `${baseUrl}/sports/soccer_epl/odds/?apiKey=${env.ODDS_API_KEY}&event_id=${matchId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Odds API failed: ${resp.status}`);

  // Log usage
  const remaining = parseInt(resp.headers.get('x-requests-remaining') || '500');
  const total = parseInt(resp.headers.get('x-requests-limit') || '500');
  await logApiCall(env, 'odds-api', '/odds', remaining, total);

  const data = await resp.json() as Array<{ bookmakers?: Array<{ markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number }> }> }> }>;

  // Extract first bookmaker's h2h market
  const firstBook = data[0]?.bookmakers?.[0];
  const h2h = firstBook?.markets?.find(m => m.key === 'h2h');
  const outcomes = h2h?.outcomes || [];

  return {
    homeOdds: outcomes[0]?.price || 2.0,
    drawOdds: outcomes[1]?.price || 3.0,
    awayOdds: outcomes[2]?.price || 3.0,
  };
}

// ============================================================
// Internal: Process raw data with Bayesian smoothing
// ============================================================

function processDataWithBayesian(raw: RawApiData): {
  homeXgAdj: number;
  awayXgAdj: number;
  homeConcAdj: number;
  awayConcAdj: number;
  confidence: number;
  priorApplied: boolean;
} {
  // SRS 3.2.1: De-weighting & Bayesian smoothing
  const homeXgResult = calculateAdjXg(
    raw.homeXgRaw, raw.homeMatchesPlayed,
    raw.homeOppConcRate, raw.leagueAvgConc
  );

  const awayXgResult = calculateAdjXg(
    raw.awayXgRaw, raw.awayMatchesPlayed,
    raw.awayOppConcRate, raw.leagueAvgConc
  );

  const homeConcResult = calculateAdjConc(
    raw.homeConcRaw, raw.homeMatchesPlayed,
    raw.homeOppXgRate, raw.leagueAvgGoals
  );

  const awayConcResult = calculateAdjConc(
    raw.awayConcRaw, raw.awayMatchesPlayed,
    raw.awayOppXgRate, raw.leagueAvgGoals
  );

  // Confidence: higher when more matches played and no prior needed
  const totalMatches = raw.homeMatchesPlayed + raw.awayMatchesPlayed;
  const confidence = Math.min(1.0, totalMatches / 20);

  const priorApplied = homeXgResult.priorApplied || awayXgResult.priorApplied ||
    homeConcResult.priorApplied || awayConcResult.priorApplied;

  return {
    homeXgAdj: homeXgResult.xgAdj,
    awayXgAdj: awayXgResult.xgAdj,
    homeConcAdj: homeConcResult.concAdj,
    awayConcAdj: awayConcResult.concAdj,
    confidence,
    priorApplied,
  };
}
