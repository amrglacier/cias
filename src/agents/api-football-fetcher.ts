// ============================================================
// CIAS - API-Football Data Fetcher (Real Implementation)
// Fetches fixtures, team stats, injuries, lineups from API-Football
// ============================================================

import type { Env, MatchInfo } from '../types';
import { logApiCall } from './data-agent';
import { getSupabase } from '../db/client';
import { getConfig, upsertMatch, getMatch } from '../db/repository';
import { mergeBettingWindowConfig, type BettingWindowConfig } from '../config/defaults';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchWithRetry } from '../utils/http';

interface ApiFootballResponse<T> {
  response: T[];
  errors?: unknown;
}

interface FixtureResponse {
  fixture: {
    id: number;
    date: string;
    status: { short: string; long: string };
    venue?: { name: string; city: string };
    referee?: string;
  };
  teams: {
    home: { id: number; name: string; logo?: string };
    away: { id: number; name: string; logo?: string };
  };
  league: {
    id: number;
    name: string;
    season: number;
    round?: string;
  };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
  };
}

interface TeamStatsResponse {
  league: {
    id: number;
    name: string;
    season: number;
  };
  team: {
    id: number;
    name: string;
  };
  fixtures: {
    played: { home: number; away: number; total: number };
    wins: { home: number; away: number; total: number };
    draws: { home: number; away: number; total: number };
    loses: { home: number; away: number; total: number };
  };
  goals: {
    for: {
      total: { home: number | null; away: number | null; total: number | null };
      average: { home: string | null; away: string | null; total: string | null };
    };
    against: {
      total: { home: number | null; away: number | null; total: number | null };
      average: { home: string | null; away: string | null; total: string | null };
    };
  };
  cards?: {
    yellow?: { total?: string; average?: string };
    red?: { total?: string; average?: string };
  };
  fouls?: { total?: string; average?: string };
}

interface InjuryResponse {
  player: { id: number; name: string; type: string };
  team: { id: number; name: string };
  league: { id: number; name: string };
  games: { league: string; type: string; reason: string };
  injuries: { reason: string; departure: string; date: string };
}

interface LineupResponse {
  team: { id: number; name: string; logo: string };
  coach: { id: number; name: string };
  formation: string;
  startXI: Array<{ player: { id: number; name: string; pos: string; grid?: string } }>;
}

interface RefereeResponse {
  referee: { id: number; name: string };
  fixture: { id: number; date: string };
  cards: {
    yellow: { total: number; average?: string };
    red: { total: number; average?: string };
  };
  fouls: { total: number; average?: string };
}

/**
 * Fetch upcoming fixtures from API-Football for configured leagues.
 * Stores them in matches table.
 */
export async function fetchAndStoreUpcomingFixtures(env: Env): Promise<number> {
  const db = getSupabase(env);
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  const config = await getBettingWindowConfig(db);

  let totalStored = 0;
  for (const leagueId of config.api_football_league_ids) {
    const url = `${baseUrl}/fixtures?league=${leagueId}&season=${config.season}&next=10`;
    try {
      const resp = await fetchWithRetry(url, { headers });
      if (!resp.ok) {
        console.error(`[API-Football] Fixtures for league ${leagueId} failed: ${resp.status}`);
        continue;
      }
      logRateLimit(env, 'api-football', '/fixtures', resp);

      const data = await resp.json() as ApiFootballResponse<FixtureResponse>;
      if (!data.response) continue;

      for (const item of data.response) {
        const matchId = `af_${item.fixture.id}`;
        const kickoffTime = new Date(item.fixture.date).toISOString();
        const status = mapFixtureStatus(item.fixture.status.short);
        await upsertMatch(db, {
          matchId,
          homeTeam: item.teams.home.name,
          awayTeam: item.teams.away.name,
          league: item.league.name,
          leagueId: item.league.id,
          season: String(item.league.season),
          kickoffTime,
          status,
          homeScore: item.goals.home ?? undefined,
          awayScore: item.goals.away ?? undefined,
          halftimeHome: item.score.halftime.home ?? undefined,
          halftimeAway: item.score.halftime.away ?? undefined,
          round: item.league.round,
          venue: item.fixture.venue?.name,
        });
        totalStored++;
      }
    } catch (err) {
      console.error(`[API-Football] Error fetching league ${leagueId}:`, err);
    }
  }

  console.log(`[API-Football] Stored ${totalStored} upcoming fixtures`);
  return totalStored;
}

/**
 * Fetch finished matches and update scores.
 */
export async function fetchAndStoreFinishedMatches(env: Env): Promise<number> {
  const db = getSupabase(env);
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  const config = await getBettingWindowConfig(db);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 36 * 3600_000).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  let totalUpdated = 0;
  for (const leagueId of config.api_football_league_ids) {
    const url = `${baseUrl}/fixtures?league=${leagueId}&season=${config.season}&from=${yesterday}&to=${today}`;
    try {
      const resp = await fetchWithRetry(url, { headers });
      if (!resp.ok) continue;
      logRateLimit(env, 'api-football', '/fixtures', resp);

      const data = await resp.json() as ApiFootballResponse<FixtureResponse>;
      if (!data.response) continue;

      for (const item of data.response) {
        const matchId = `af_${item.fixture.id}`;
        const status = mapFixtureStatus(item.fixture.status.short);
        if (status !== 'finished') continue;

        await upsertMatch(db, {
          matchId,
          homeTeam: item.teams.home.name,
          awayTeam: item.teams.away.name,
          league: item.league.name,
          leagueId: item.league.id,
          season: String(item.league.season),
          kickoffTime: new Date(item.fixture.date).toISOString(),
          status: 'finished',
          homeScore: item.goals.home ?? undefined,
          awayScore: item.goals.away ?? undefined,
          halftimeHome: item.score.halftime.home ?? undefined,
          halftimeAway: item.score.halftime.away ?? undefined,
          round: item.league.round,
          venue: item.fixture.venue?.name,
        });
        totalUpdated++;
      }
    } catch (err) {
      console.error(`[API-Football] Error fetching finished for league ${leagueId}:`, err);
    }
  }

  console.log(`[API-Football] Updated ${totalUpdated} finished matches`);
  return totalUpdated;
}

/**
 * Fetch comprehensive team statistics for a match.
 * Returns raw data for Bayesian processing.
 */
export async function fetchRealTeamStats(
  env: Env,
  leagueId: number,
  season: string,
  teamId: number,
  side: 'home' | 'away'
): Promise<{
  xgRaw: number;
  concRaw: number;
  matchesPlayed: number;
  oppConcRate: number;
  oppXgRate: number;
  yellowCardAvg: number;
  redCardAvg: number;
  foulsPerGame: number;
}> {
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  const url = `${baseUrl}/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`;
  const resp = await fetchWithRetry(url, { headers });
  if (!resp.ok) throw new Error(`Team stats failed for team ${teamId}: ${resp.status}`);
  logRateLimit(env, 'api-football', '/teams/statistics', resp);

  const data = await resp.json() as ApiFootballResponse<TeamStatsResponse>;
  const stats = data.response?.[0];
  if (!stats) throw new Error(`No stats for team ${teamId}`);

  const xgRaw = parseFloat(stats.goals?.for?.average?.total || '1.3');
  const concRaw = parseFloat(stats.goals?.against?.average?.total || '1.3');
  const matchesPlayed = stats.fixtures?.played?.total || 10;
  const yellowCardAvg = parseFloat(stats.cards?.yellow?.average || '3.5');
  const redCardAvg = parseFloat(stats.cards?.red?.average || '0.2');
  const foulsPerGame = parseFloat(stats.fouls?.average || '22');

  return {
    xgRaw,
    concRaw,
    matchesPlayed,
    oppConcRate: 1.3, // League avg concession rate (would fetch separately)
    oppXgRate: 1.3,   // League avg xG rate
    yellowCardAvg,
    redCardAvg,
    foulsPerGame,
  };
}

/**
 * Fetch injury data for a team.
 */
export async function fetchRealInjuries(
  env: Env,
  leagueId: number,
  season: string,
  teamId: number
): Promise<{ position: 'GK' | 'DEF' | 'MID' | 'FWD'; importance: number }[]> {
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  const url = `${baseUrl}/injuries?league=${leagueId}&season=${season}&team=${teamId}`;
  const resp = await fetchWithRetry(url, { headers });
  if (!resp.ok) return [];
  logRateLimit(env, 'api-football', '/injuries', resp);

  const data = await resp.json() as ApiFootballResponse<InjuryResponse>;
  if (!data.response) return [];

  return data.response.map(inj => {
    const pos = inferPosition(inj.player.type, inj.games.type);
    const importance = pos === 'GK' ? 0.8 : pos === 'DEF' ? 0.6 : pos === 'MID' ? 0.4 : 0.3;
    return { position: pos, importance };
  }).slice(0, 5);
}

/**
 * Fetch lineup/formation data.
 */
export async function fetchRealLineup(
  env: Env,
  fixtureId: number
): Promise<{ home: string; away: string }> {
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  const url = `${baseUrl}/fixtures/lineups?fixture=${fixtureId}`;
  const resp = await fetchWithRetry(url, { headers });
  if (!resp.ok) return { home: '4-3-3', away: '4-4-2' };
  logRateLimit(env, 'api-football', '/fixtures/lineups', resp);

  const data = await resp.json() as ApiFootballResponse<LineupResponse>;
  if (!data.response || data.response.length < 2) return { home: '4-3-3', away: '4-4-2' };

  return {
    home: data.response[0]?.formation || '4-3-3',
    away: data.response[1]?.formation || '4-4-2',
  };
}

/**
 * Fetch referee statistics from API-Football.
 */
export async function fetchRealReferee(
  env: Env,
  fixtureId: number
): Promise<{ yellowCardAvg: number; redCardAvg: number; foulsPerGame: number }> {
  const baseUrl = env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
  const isRapidAPI = baseUrl.includes('rapidapi.com');
  const headers: Record<string, string> = isRapidAPI
    ? { 'x-rapidapi-key': env.API_FOOTBALL_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' }
    : { 'x-apisports-key': env.API_FOOTBALL_KEY };

  // Try referee endpoint
  const url = `${baseUrl}/fixtures/referees?fixture=${fixtureId}`;
  const resp = await fetchWithRetry(url, { headers });
  if (!resp.ok) return { yellowCardAvg: 3.5, redCardAvg: 0.2, foulsPerGame: 22 };
  logRateLimit(env, 'api-football', '/fixtures/referees', resp);

  const data = await resp.json() as ApiFootballResponse<RefereeResponse>;
  if (!data.response || data.response.length === 0) {
    return { yellowCardAvg: 3.5, redCardAvg: 0.2, foulsPerGame: 22 };
  }

  const ref = data.response[0];
  return {
    yellowCardAvg: ref.cards?.yellow?.average ? parseFloat(ref.cards.yellow.average) : 3.5,
    redCardAvg: ref.cards?.red?.average ? parseFloat(ref.cards.red.average) : 0.2,
    foulsPerGame: ref.fouls?.average ? parseFloat(ref.fouls.average) : 22,
  };
}

/**
 * Get odds for a fixture from The Odds API.
 */
export async function fetchRealOdds(
  env: Env,
  matchId: string,
  sportKey: string
): Promise<{ homeOdds: number; drawOdds: number; awayOdds: number }> {
  const baseUrl = env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
  // Extract the API-Football fixture ID from matchId (af_XXXXX)
  const fixtureNumericId = matchId.replace('af_', '');

  // Try to find the matching event in The Odds API
  // Pass API key via header instead of URL query param to avoid logging exposure
  const url = `${baseUrl}/sports/${sportKey}/odds/?regions=eu&markets=h2h&oddsFormat=decimal`;
  const resp = await fetchWithRetry(url, {
    headers: { 'x-api-key': env.ODDS_API_KEY },
  });
  if (!resp.ok) throw new Error(`Odds API failed: ${resp.status}`);

  // Log rate limit
  const remaining = parseInt(resp.headers.get('x-requests-remaining') || '500');
  const total = parseInt(resp.headers.get('x-requests-limit') || '500');
  await logApiCall(env, 'odds-api', '/odds', remaining, total);

  const data = await resp.json() as Array<{
    id: string;
    home_team: string;
    away_team: string;
    bookmakers?: Array<{
      markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number }> }>;
    }>;
  }>;

  // Find the matching event by team names - we need to look up the match in DB
  const db = getSupabase(env);
  const match = await getMatch(db, matchId);
  if (!match) throw new Error(`Match ${matchId} not found in DB`);

  // Normalize team names for matching
  const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const event = data.find(e => {
    const homeMatch = normalizeName(e.home_team).includes(normalizeName(match.homeTeam).slice(0, 5)) ||
                     normalizeName(match.homeTeam).includes(normalizeName(e.home_team).slice(0, 5));
    const awayMatch = normalizeName(e.away_team).includes(normalizeName(match.awayTeam).slice(0, 5)) ||
                      normalizeName(match.awayTeam).includes(normalizeName(e.away_team).slice(0, 5));
    return homeMatch && awayMatch;
  });

  if (!event) {
    console.warn(`[OddsAPI] No matching event found for ${match.homeTeam} vs ${match.awayTeam}`);
    return { homeOdds: 2.0, drawOdds: 3.0, awayOdds: 3.0 };
  }

  // Extract first bookmaker's h2h market
  const firstBook = event.bookmakers?.[0];
  const h2h = firstBook?.markets?.find(m => m.key === 'h2h');
  const outcomes = h2h?.outcomes || [];

  // Match outcomes to home/draw/away
  let homeOdds = 2.0, drawOdds = 3.0, awayOdds = 3.0;
  for (const o of outcomes) {
    const normOutcome = normalizeName(o.name);
    if (normOutcome === 'draw') {
      drawOdds = o.price;
    } else if (normalizeName(match.homeTeam).includes(normOutcome.slice(0, 5)) || normOutcome.includes(normalizeName(match.homeTeam).slice(0, 5))) {
      homeOdds = o.price;
    } else {
      awayOdds = o.price;
    }
  }

  return { homeOdds, drawOdds, awayOdds };
}

// ============================================================
// Helper functions
// ============================================================

async function getBettingWindowConfig(db: SupabaseClient): Promise<BettingWindowConfig> {
  const raw = await getConfig(db, 'betting_window_config');
  return mergeBettingWindowConfig(raw);
}

function mapFixtureStatus(apiStatus: string): 'scheduled' | 'in_play' | 'finished' | 'cancelled' | 'postponed' {
  switch (apiStatus) {
    case 'NS': return 'scheduled';
    case '1H':
    case '2H':
    case 'HT':
    case 'ET':
    case 'BT':
    case 'P':
    case 'LIVE': return 'in_play';
    case 'FT':
    case 'AET':
    case 'PEN': return 'finished';
    case 'PST': return 'postponed';
    case 'CANC': return 'cancelled';
    default: return 'scheduled';
  }
}

function inferPosition(playerType: string, gameType: string): 'GK' | 'DEF' | 'MID' | 'FWD' {
  const t = (playerType || '').toLowerCase();
  if (t.includes('goalkeeper') || t.includes('gk')) return 'GK';
  if (t.includes('defender') || t.includes('def') || t.includes('centre-back') || t.includes('fullback')) return 'DEF';
  if (t.includes('midfielder') || t.includes('mid') || t.includes('winger')) return 'MID';
  if (t.includes('forward') || t.includes('striker') || t.includes('attacker') || t.includes('wing')) return 'FWD';
  return 'MID';
}

async function logRateLimit(env: Env, apiName: string, endpoint: string, resp: Response): Promise<void> {
  const remaining = parseInt(resp.headers.get('x-ratelimit-remaining') || '100');
  const total = parseInt(resp.headers.get('x-ratelimit-limit') || '100');
  await logApiCall(env, apiName, endpoint, remaining, total);
}
