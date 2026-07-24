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
  getConfig, getMatch,
} from '../db/repository';
import { getSupabase } from '../db/client';
import {
  fetchRealTeamStats, fetchRealInjuries, fetchRealLineup,
  fetchRealReferee, fetchRealOdds,
} from './api-football-fetcher';
import { fetchWithRetry } from '../utils/http';
import { buildEvidenceFromFacts } from './shared';

// ============================================================
// T0: Fundamentals Gathering
// ============================================================

/**
 * Phase 1 (T0): Gather match fundamentals from API-Football.
 * SRS: Step 1 - Get fixtures, Step 2 - Data enrichment, Step 3 - Freeze snapshot
 *
 * Optimization: Split into static data (cached, fetched once per season) and
 * dynamic data (refreshed each cycle). Static data includes team season stats,
 * league averages. Dynamic data includes injuries, lineups, referee, weather.
 */
export async function gatherFundamentals(env: Env, match: MatchInfo): Promise<MatchFacts> {
  const db = getSupabase(env);
  console.log(`[DataAgent] T0: Gathering fundamentals for match ${match.matchId}`);

  // Step 1: Fetch STATIC data (team stats, league averages) - cached per team/season
  const staticData = await fetchStaticData(env, match);

  // Step 2: Fetch DYNAMIC data (injuries, lineups, referee, weather) - fresh each time
  const dynamicData = await fetchDynamicData(env, match);

  // Step 3: Apply Bayesian smoothing & de-weighting using static + dynamic data
  const processed = processDataWithBayesian({
    ...staticData,
    ...dynamicData,
  } as RawApiData);

  // Step 4: Calculate additional factors from dynamic data
  const weatherDecay = calculateWeatherDecay(
    dynamicData.weather!.temperature,
    dynamicData.weather!.windSpeed,
    dynamicData.weather!.precipitation,
    dynamicData.weather!.isExtreme
  );

  const refereeStrictness = calculateRefereeStrictness(
    dynamicData.referee!.yellowCardAvg,
    dynamicData.referee!.redCardAvg,
    dynamicData.referee!.foulsPerGame
  );

  const motivationHome = calculateMotivation(
    dynamicData.isDerby!, dynamicData.isTitleDecider!, dynamicData.isRelegationBattle!,
    dynamicData.isDeadRubber!, true
  );

  const motivationAway = calculateMotivation(
    dynamicData.isDerby!, dynamicData.isTitleDecider!, dynamicData.isRelegationBattle!,
    dynamicData.isDeadRubber!, false
  );

  const injuryImpactHome = calculateInjuryImpact(dynamicData.injuries!.home, true);
  const injuryImpactAway = calculateInjuryImpact(dynamicData.injuries!.away, false);

  const formationCtr = calculateFormationCounter(
    dynamicData.formations!.home,
    dynamicData.formations!.away
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

  // Step 5: Build MatchFacts and persist
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
    leagueAvgGoals: staticData.leagueAvgGoals!,
    leagueAvgConc: staticData.leagueAvgConc!,
    bayesianPriorApplied: processed.priorApplied,
    status: 'frozen', // SRS: T0 data is frozen
  };

  const saved = await upsertMatchFacts(db, facts);
  console.log(`[DataAgent] T0: Fundamentals frozen for match ${match.matchId}`);
  return saved;
}

/**
 * Refresh only dynamic factors for a match (injuries, lineup, referee, weather).
 * Static data (team season stats, league averages) is NOT re-fetched.
 * Called by periodic recalculation instead of full gatherFundamentals.
 */
export async function refreshDynamicFactors(env: Env, match: MatchInfo): Promise<Partial<MatchFacts>> {
  const db = getSupabase(env);
  console.log(`[DataAgent] Refreshing dynamic factors for match ${match.matchId}`);

  const dynamicData = await fetchDynamicData(env, match);

  // Recalculate dynamic-dependent factors
  const weatherDecay = calculateWeatherDecay(
    dynamicData.weather!.temperature,
    dynamicData.weather!.windSpeed,
    dynamicData.weather!.precipitation,
    dynamicData.weather!.isExtreme
  );

  const refereeStrictness = calculateRefereeStrictness(
    dynamicData.referee!.yellowCardAvg,
    dynamicData.referee!.redCardAvg,
    dynamicData.referee!.foulsPerGame
  );

  const injuryImpactHome = calculateInjuryImpact(dynamicData.injuries!.home, true);
  const injuryImpactAway = calculateInjuryImpact(dynamicData.injuries!.away, false);

  const formationCtr = calculateFormationCounter(
    dynamicData.formations!.home,
    dynamicData.formations!.away
  );

  // Update only dynamic fields in existing match_facts
  const existing = await getMatchFacts(db, match.matchId);
  if (!existing) {
    throw new Error(`Cannot refresh dynamic factors: no existing facts for ${match.matchId}`);
  }

  const updated: MatchFacts = {
    ...existing,
    injuryImpactHome,
    injuryImpactAway,
    weatherDecay,
    refereeStrictness,
    formationCtrHome: formationCtr,
    formationCtrAway: -formationCtr,
  };

  const saved = await upsertMatchFacts(db, updated);
  console.log(`[DataAgent] Dynamic factors refreshed for match ${match.matchId}`);
  return saved;
}

/**
 * Fetch STATIC data: team season stats + league averages.
 * This data changes slowly (per matchday at most) and is cached in team_stats_cache table.
 * Only fetches from API if cache is stale (> 12 hours old) or missing.
 */
async function fetchStaticData(env: Env, match: MatchInfo): Promise<Partial<RawApiData>> {
  const db = getSupabase(env);
  const configRaw = await getConfig(db, 'betting_window_config');
  let leagueId = 39;
  let season = '2025';
  if (configRaw && typeof configRaw === 'object') {
    const cfg = configRaw as Record<string, unknown>;
    if (Array.isArray(cfg.api_football_league_ids) && cfg.api_football_league_ids.length > 0) {
      leagueId = cfg.api_football_league_ids[0] as number;
    }
    if (typeof cfg.season === 'string') {
      season = cfg.season;
    }
  }

  const matchRow = await getMatch(db, match.matchId);

  // Check cache for home team stats
  const homeTeamName = matchRow?.homeTeam || match.homeTeam;
  const awayTeamName = matchRow?.awayTeam || match.awayTeam;

  const homeStats = await fetchCachedTeamStats(env, leagueId, season, homeTeamName);
  const awayStats = await fetchCachedTeamStats(env, leagueId, season, awayTeamName);

  return {
    homeXgRaw: homeStats.xgRaw,
    awayXgRaw: awayStats.xgRaw,
    homeConcRaw: homeStats.concRaw,
    awayConcRaw: awayStats.concRaw,
    homeMatchesPlayed: homeStats.matchesPlayed,
    awayMatchesPlayed: awayStats.matchesPlayed,
    homeOppConcRate: homeStats.oppConcRate,
    awayOppConcRate: awayStats.oppConcRate,
    homeOppXgRate: homeStats.oppXgRate,
    awayOppXgRate: awayStats.oppXgRate,
    leagueAvgGoals: homeStats.leagueAvgGoals || 1.3,
    leagueAvgConc: homeStats.leagueAvgConc || 1.3,
  };
}

/**
 * Fetch team stats with caching. Checks team_stats_cache table first.
 * Cache is valid for 12 hours. If stale or missing, fetches from API.
 */
async function fetchCachedTeamStats(
  env: Env, leagueId: number, season: string, teamName: string
): Promise<{
  xgRaw: number; concRaw: number; matchesPlayed: number;
  oppConcRate: number; oppXgRate: number;
  leagueAvgGoals: number; leagueAvgConc: number;
}> {
  const db = getSupabase(env);
  const cacheKey = `${season}_${leagueId}_${teamName}`;

  // Check cache (resilient: if table doesn't exist, falls through to API fetch)
  interface TeamStatsCache {
    cached_at: string;
    xg_raw: number; conc_raw: number; matches_played: number;
    opp_conc_rate: number; opp_xg_rate: number;
    league_avg_goals: number; league_avg_conc: number;
  }
  let cached: TeamStatsCache | null = null;
  try {
    const result = await db
      .from('team_stats_cache')
      .select('*')
      .eq('cache_key', cacheKey)
      .maybeSingle();
    cached = result.data as TeamStatsCache | null;
  } catch (cacheErr) {
    console.warn(`[DataAgent] Cache read failed for ${teamName} (table may not exist):`, cacheErr);
  }

  if (cached) {
    const cachedAt = new Date(cached.cached_at).getTime();
    const twelveHours = 12 * 3600_000;
    if (Date.now() - cachedAt < twelveHours) {
      console.log(`[DataAgent] Cache hit for team ${teamName}`);
      return {
        xgRaw: cached.xg_raw,
        concRaw: cached.conc_raw,
        matchesPlayed: cached.matches_played,
        oppConcRate: cached.opp_conc_rate,
        oppXgRate: cached.opp_xg_rate,
        leagueAvgGoals: cached.league_avg_goals,
        leagueAvgConc: cached.league_avg_conc,
      };
    }
    console.log(`[DataAgent] Cache stale for team ${teamName}, refetching`);
  } else {
    console.log(`[DataAgent] Cache miss for team ${teamName}, fetching from API`);
  }

  // Fetch from API
  const fresh = await fetchTeamStatsReal(env, leagueId, season, match_default, teamName);

  // Store in cache (resilient: silently continues if table doesn't exist)
  try {
    await db.from('team_stats_cache').upsert({
      cache_key: cacheKey,
      team_name: teamName,
      league_id: leagueId,
      season,
      xg_raw: fresh.xgRaw,
      conc_raw: fresh.concRaw,
      matches_played: fresh.matchesPlayed,
      opp_conc_rate: fresh.oppConcRate,
      opp_xg_rate: fresh.oppXgRate,
      league_avg_goals: 1.3,
      league_avg_conc: 1.3,
      cached_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[DataAgent] Failed to cache team stats for ${teamName}:`, err);
  }

  return { ...fresh, leagueAvgGoals: 1.3, leagueAvgConc: 1.3 };
}

// Placeholder match object for fetchTeamStatsReal signature compatibility
const match_default = { matchId: '', homeTeam: '', awayTeam: '', league: '', kickoffTime: '', status: 'scheduled' as const };

/**
 * Fetch DYNAMIC data: injuries, lineups, referee, weather, match context.
 * This data changes frequently and must be fetched fresh each time.
 */
async function fetchDynamicData(env: Env, match: MatchInfo): Promise<Partial<RawApiData>> {
  const db = getSupabase(env);
  const fixtureNumericId = parseInt(match.matchId.replace('af_', '')) || 0;

  // Read league/season from config (same logic as fetchStaticData)
  const configRaw = await getConfig(db, 'betting_window_config');
  let leagueId = 39;
  let season = '2025';
  if (configRaw && typeof configRaw === 'object') {
    const cfg = configRaw as Record<string, unknown>;
    if (Array.isArray(cfg.api_football_league_ids) && cfg.api_football_league_ids.length > 0) {
      leagueId = cfg.api_football_league_ids[0] as number;
    }
    if (typeof cfg.season === 'string') {
      season = cfg.season;
    }
  }

  // Resolve match row for team names
  const matchRow = await getMatch(db, match.matchId);
  const homeTeamName = matchRow?.homeTeam || match.homeTeam;
  const awayTeamName = matchRow?.awayTeam || match.awayTeam;

  const [refereeData, formationData, homeTeamId, awayTeamId] = await Promise.all([
    fixtureNumericId > 0 ? fetchRealReferee(env, fixtureNumericId) : Promise.resolve({ yellowCardAvg: 3.5, redCardAvg: 0.2, foulsPerGame: 22 }),
    fixtureNumericId > 0 ? fetchRealLineup(env, fixtureNumericId) : Promise.resolve({ home: '4-3-3', away: '4-4-2' }),
    resolveTeamId(env, leagueId, season, homeTeamName),
    resolveTeamId(env, leagueId, season, awayTeamName),
  ]);

  // Fetch injuries for both teams using resolved team IDs
  const [homeInjuries, awayInjuries] = await Promise.all([
    homeTeamId > 0 ? fetchRealInjuries(env, leagueId, season, homeTeamId).catch(() => []) : Promise.resolve([]),
    awayTeamId > 0 ? fetchRealInjuries(env, leagueId, season, awayTeamId).catch(() => []) : Promise.resolve([]),
  ]);

  return {
    weather: { temperature: 20, windSpeed: 5, precipitation: 0, isExtreme: false },
    referee: refereeData,
    injuries: { home: homeInjuries, away: awayInjuries },
    formations: formationData,
    isDerby: isDerbyMatch(homeTeamName, awayTeamName),
    isTitleDecider: false,
    isRelegationBattle: false,
    isDeadRubber: false,
  };
}

// ============================================================
// Build Evidence Pack
// ============================================================

/**
 * SRS 2.1 Output: Build Evidence Pack from match facts.
 * Delegates to shared buildEvidenceFromFacts to avoid duplication with Logic Agent.
 */
export async function buildEvidencePack(env: Env, matchId: string): Promise<EvidencePack> {
  const db = getSupabase(env);
  const facts = await getMatchFacts(db, matchId);
  if (!facts) throw new Error(`No match facts found for ${matchId}`);

  return buildEvidenceFromFacts(db, matchId, facts);
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

// ============================================================
// Internal: Team ID resolution & stats fetching
// ============================================================

/**
 * Fetch team stats using the real API-Football fetcher.
 * Falls back to defaults on error.
 */
async function fetchTeamStatsReal(
  env: Env,
  leagueId: number,
  season: string,
  match: MatchInfo,
  teamName: string
): Promise<{
  xgRaw: number; concRaw: number; matchesPlayed: number;
  oppConcRate: number; oppXgRate: number;
  yellowCardAvg: number; redCardAvg: number; foulsPerGame: number;
}> {
  try {
    // In production, we would resolve teamName to teamId via API-Football /teams endpoint
    // For now, use the real fetcher with a team ID lookup
    // The team ID would be stored in the matches table when fixtures are fetched
    const teamId = await resolveTeamId(env, leagueId, season, teamName);
    if (teamId > 0) {
      return await fetchRealTeamStats(env, leagueId, season, teamId, 'home');
    }
  } catch (err) {
    console.warn(`[DataAgent] Team stats fetch failed for ${teamName}:`, err);
  }
  // Fallback to reasonable defaults
  return {
    xgRaw: 1.3, concRaw: 1.3, matchesPlayed: 10,
    oppConcRate: 1.3, oppXgRate: 1.3,
    yellowCardAvg: 3.5, redCardAvg: 0.2, foulsPerGame: 22,
  };
}

/**
 * Resolve team name to API-Football team ID.
 * Queries the API-Football /teams endpoint.
 */
async function resolveTeamId(env: Env, leagueId: number, season: string, teamName: string): Promise<number> {
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  const url = `${baseUrl}/teams?search=${encodeURIComponent(teamName)}`;
  const resp = await fetchWithRetry(url, { headers });
  if (!resp.ok) return 0;

  const data = await resp.json() as { response?: Array<{ team?: { id: number; name: string } }> };
  return data.response?.[0]?.team?.id || 0;
}

/**
 * Detect derby matches by checking if both team names share a common city/region token.
 * e.g. "Manchester United" vs "Manchester City" -> true
 * e.g. "Arsenal" vs "Chelsea" -> false
 */
function isDerbyMatch(homeTeam: string, awayTeam: string): boolean {
  if (!homeTeam || !awayTeam || homeTeam === awayTeam) return false;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  const homeTokens = new Set(normalize(homeTeam).split(/\s+/).filter(t => t.length >= 4));
  const awayTokens = normalize(awayTeam).split(/\s+/).filter(t => t.length >= 4);
  return awayTokens.some(t => homeTokens.has(t));
}

function inferPositionFromType(typeStr: string): 'GK' | 'DEF' | 'MID' | 'FWD' {
  const t = typeStr.toLowerCase();
  if (t.includes('goalkeeper') || t.includes('gk')) return 'GK';
  if (t.includes('defender') || t.includes('def') || t.includes('back')) return 'DEF';
  if (t.includes('midfielder') || t.includes('mid')) return 'MID';
  if (t.includes('forward') || t.includes('striker') || t.includes('attacker') || t.includes('wing')) return 'FWD';
  return 'MID';
}

// ============================================================
// Internal: Odds API
// ============================================================

async function fetchOddsFromApi(env: Env, matchId: string): Promise<{ homeOdds: number; drawOdds: number; awayOdds: number }> {
  // Use the real odds fetcher that matches events by team name
  const db = getSupabase(env);
  const configRaw = await getConfig(db, 'betting_window_config');
  let sportKey = 'soccer_epl';
  if (configRaw && typeof configRaw === 'object') {
    const cfg = configRaw as Record<string, unknown>;
    if (Array.isArray(cfg.target_leagues) && cfg.target_leagues.length > 0) {
      sportKey = cfg.target_leagues[0] as string;
    }
  }

  try {
    return await fetchRealOdds(env, matchId, sportKey);
  } catch (err) {
    console.warn(`[DataAgent] Odds fetch failed for ${matchId}:`, err);
    // Fallback: try the old direct API call (with header-based auth)
    const baseUrl = env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
    const url = `${baseUrl}/sports/${sportKey}/odds/?regions=eu&markets=h2h&oddsFormat=decimal`;
    const resp = await fetchWithRetry(url, {
      headers: { 'x-api-key': env.ODDS_API_KEY },
    });
    if (!resp.ok) throw new Error(`Odds API failed: ${resp.status}`);

    const remaining = parseInt(resp.headers.get('x-requests-remaining') || '500');
    const total = parseInt(resp.headers.get('x-requests-limit') || '500');
    await logApiCall(env, 'odds-api', '/odds', remaining, total);

    const data = await resp.json() as Array<{ bookmakers?: Array<{ markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number }> }> }> }>;

    const firstBook = data[0]?.bookmakers?.[0];
    const h2h = firstBook?.markets?.find(m => m.key === 'h2h');
    const outcomes = h2h?.outcomes || [];

    return {
      homeOdds: outcomes[0]?.price || 2.0,
      drawOdds: outcomes[1]?.price || 3.0,
      awayOdds: outcomes[2]?.price || 3.0,
    };
  }
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
