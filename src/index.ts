// ============================================================
// CIAS - Main Worker Entry Point
// Cloudflare Workers + Cron Triggers + API Routes
// ============================================================

import { ConcurrencyLockDO } from './db/durable-objects';
import {
  runPhase1_T0, runPhase2_Initial, runPhase3_CrossDiscussion,
  runPhase4_InPlayMonitoring, runPhase5_FinalPublish, runFullSOP,
} from './system/orchestrator';
import { runPostMatchReview } from './review/attribution';
import { captureOddsSnapshot } from './agents/data-agent';
import { fetchAndStoreUpcomingFixtures, fetchAndStoreFinishedMatches } from './agents/api-football-fetcher';
import { getSupabase } from './db/client';
import {
  getMatchFacts, getLatestPrediction, getLockedPrediction,
  getInPlayPredictions, getReviewResults, getRecentReviews,
  getOddsSnapshotCount, getConfig, setConfig,
  getUpcomingMatches, getFinishedMatchesWithoutReview,
  getMatch, updateMatchStatus, upsertMatch,
  getAllLockedPredictions, getOddsSnapshots, getAllMatchFacts,
} from './db/repository';
import {
  mergeBettingWindowConfig, type BettingWindowConfig,
} from './config/defaults';
import type { Env, MatchInfo, MatchResult } from './types';

// ============================================================
// Worker Export
// ============================================================

export { ConcurrencyLockDO };

export default {
  // ============================================================
  // HTTP Handler (API + Cron Triggers share this)
  // ============================================================
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Authenticate write operations (POST/PUT/DELETE)
    if (request.method !== 'GET') {
      const authError = requireAuth(request, env, corsHeaders);
      if (authError) return authError;
    }

    try {
      // API Routes
      switch (path) {
        case '/':
          return jsonResponse({ status: 'ok', system: 'CIAS', version: '1.5.0' }, corsHeaders);

        case '/api/matches':
          return await handleCreateMatch(request, env, corsHeaders);

        case '/api/predict':
          return await handlePredict(request, env, corsHeaders);

        case '/api/predictions':
          return await handleGetPredictions(request, env, url, corsHeaders);

        case '/api/all-predictions':
          return await handleGetAllPredictions(env, url, corsHeaders);

        case '/api/prediction':
          return await handleGetPrediction(request, env, url, corsHeaders);

        case '/api/match-facts':
          return await handleGetMatchFacts(env, url, corsHeaders);

        case '/api/all-match-facts':
          return await handleGetAllMatchFacts(env, url, corsHeaders);

        case '/api/odds-snapshot':
          return await handleCaptureOdds(request, env, corsHeaders);

        case '/api/odds-snapshots':
          return await handleGetOddsSnapshots(env, url, corsHeaders);

        case '/api/review':
          return await handleReview(request, env, corsHeaders);

        case '/api/reviews':
          return await handleGetReviews(env, url, corsHeaders);

        case '/api/in-play':
          return await handleGetInPlay(env, url, corsHeaders);

        case '/api/health':
          return await handleHealth(env, corsHeaders);

        case '/api/run-sop':
          return await handleRunSOP(request, env, corsHeaders);

        case '/api/config':
          return await handleGetConfig(env, url, corsHeaders);

        case '/api/config/betting-window':
          if (request.method === 'GET') {
            return await handleGetBettingWindowConfig(env, corsHeaders);
          } else if (request.method === 'POST') {
            return await handleUpdateBettingWindowConfig(request, env, corsHeaders);
          }
          return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);

        case '/api/migrate':
          return await handleRunMigration(env, corsHeaders);

        default:
          // Try serving static frontend assets
          if (path.startsWith('/app/')) {
            return new Response('Not Found', { status: 404 });
          }
          return jsonResponse({ error: 'Not Found', path }, corsHeaders, 404);
      }
    } catch (error) {
      console.error('[Worker] Error:', error);
      return jsonResponse(
        { error: 'Internal Server Error', message: (error as Error).message },
        corsHeaders,
        500
      );
    }
  },

  // ============================================================
  // Scheduled Handler (Cron Triggers)
  // ============================================================
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] Triggered: ${event.cron} at ${new Date().toISOString()}`);

    // Determine which cron job triggered
    if (event.cron === '0 */2 * * *') {
      // T0 + T1~Tn: Fundamentals gathering and in-play monitoring
      await runScheduledFundamentalsAndMonitoring(env);
    } else if (event.cron === '*/30 * * * *') {
      // Odds snapshot capture every 30 minutes
      await runScheduledOddsCapture(env);
    } else if (event.cron === '0 */6 * * *') {
      // Post-match review every 6 hours
      await runScheduledReview(env);
    }
  },
};

// ============================================================
// Scheduled Job Handlers (Real Implementation)
// ============================================================

/**
 * Cron 1 (every 2 hours): Fundamentals gathering + in-play monitoring.
 * - Fetch upcoming fixtures from API-Football
 * - For matches entering the fundamentals window (start_hours - fundamentals_delay):
 *   run Phase 1 (T0) + Phase 2 (Initial) + Phase 3 (Cross-Discussion)
 * - For matches in the final lock window (end_minutes + final_lock_minutes): run Phase 5 (Final Publish)
 * - For in-play matches: run Phase 4
 */
async function runScheduledFundamentalsAndMonitoring(env: Env): Promise<void> {
  console.log('[Cron] Running fundamentals + monitoring cycle');
  const db = getSupabase(env);

  // Step 1: Fetch and store upcoming fixtures from API-Football
  try {
    const stored = await fetchAndStoreUpcomingFixtures(env);
    console.log(`[Cron] Fetched ${stored} upcoming fixtures`);
  } catch (err) {
    console.error('[Cron] Failed to fetch fixtures:', err);
  }

  // Step 2: Fetch finished matches and update scores
  try {
    const updated = await fetchAndStoreFinishedMatches(env);
    console.log(`[Cron] Updated ${updated} finished matches`);
  } catch (err) {
    console.error('[Cron] Failed to fetch finished matches:', err);
  }

  // Step 3: Get betting window config
  const configRaw = await getConfig(db, 'betting_window_config');
  const config = mergeBettingWindowConfig(configRaw);

  // Fundamentals trigger: start_hours_before_kickoff - fundamentals_delay_after_start_hours
  // e.g. if start=2h and delay=0.5h, fundamentals trigger at 1.5h before kickoff
  const fundamentalsTriggerHours = config.start_hours_before_kickoff - config.fundamentals_delay_after_start_hours;

  // Final lock trigger: end_minutes_before_kickoff + final_lock_minutes_before_end
  // e.g. if end=15min and lock=15min, final lock triggers at 30min before kickoff
  const finalLockMinutes = config.end_minutes_before_kickoff + config.final_lock_minutes_before_end;

  // Step 4: Process upcoming matches in the pre-match window
  const upcomingMatches = await getUpcomingMatches(db, config.start_hours_before_kickoff + 1);
  const now = new Date();

  for (const matchRow of upcomingMatches) {
    const kickoff = new Date(matchRow.kickoffTime);
    const hoursBeforeKickoff = (kickoff.getTime() - now.getTime()) / 3600_000;
    const minutesBeforeKickoff = (kickoff.getTime() - now.getTime()) / 60_000;

    // Fundamentals: trigger after the delay window (e.g. 1.5h before kickoff, not 2h)
    // This avoids congestion and data delay at the exact start time
    if (hoursBeforeKickoff <= fundamentalsTriggerHours && hoursBeforeKickoff > 0) {
      console.log(`[Cron] Match ${matchRow.matchId} is in fundamentals window (${hoursBeforeKickoff.toFixed(2)}h before kickoff, trigger at ${fundamentalsTriggerHours}h)`);

      // Check if fundamentals already gathered
      const existingFacts = await getMatchFacts(db, matchRow.matchId);
      if (!existingFacts) {
        try {
          // Build MatchInfo from match row
          const matchInfo: MatchInfo = {
            matchId: matchRow.matchId,
            homeTeam: matchRow.homeTeam,
            awayTeam: matchRow.awayTeam,
            league: matchRow.league,
            kickoffTime: matchRow.kickoffTime,
            status: 'scheduled',
          };

          // Phase 1: T0 - Gather fundamentals
          await runPhase1_T0(env, matchInfo);
          console.log(`[Cron] Phase 1 (T0) complete for ${matchRow.matchId}`);

          // Phase 2: Initial prediction
          await runPhase2_Initial(env, matchRow.matchId);
          console.log(`[Cron] Phase 2 (Initial) complete for ${matchRow.matchId}`);

          // Phase 3: Cross-discussion
          await runPhase3_CrossDiscussion(env, matchRow.matchId);
          console.log(`[Cron] Phase 3 (Cross-Discussion) complete for ${matchRow.matchId}`);
        } catch (err) {
          console.error(`[Cron] Error processing pre-match for ${matchRow.matchId}:`, err);
        }
      }
    }

    // Final lock: trigger before the betting end time (e.g. 30min before kickoff)
    // This gives enough buffer before the betting window closes
    if (minutesBeforeKickoff <= finalLockMinutes && minutesBeforeKickoff > config.end_minutes_before_kickoff) {
      console.log(`[Cron] Match ${matchRow.matchId} is in final lock window (${minutesBeforeKickoff.toFixed(0)}min before kickoff, lock at ${finalLockMinutes}min)`);

      try {
        // Check if not already locked
        const existing = await getLockedPrediction(db, matchRow.matchId);
        if (!existing) {
          // Phase 5: Final Publish
          await runPhase5_FinalPublish(env, matchRow.matchId);
          console.log(`[Cron] Phase 5 (Final Publish) complete for ${matchRow.matchId}`);
        }
      } catch (err) {
        console.error(`[Cron] Error in final publish for ${matchRow.matchId}:`, err);
      }
    }
  }

  // Step 5: Process in-play matches (Phase 4)
  try {
    const { data: inPlayMatches } = await db
      .from('matches')
      .select('*')
      .eq('status', 'in_play')
      .limit(20);

    if (inPlayMatches) {
      for (const m of inPlayMatches) {
        const matchId = m.match_id as string;
        try {
          const matchInfo: MatchInfo = {
            matchId,
            homeTeam: m.home_team as string,
            awayTeam: m.away_team as string,
            league: (m.league as string) || '',
            kickoffTime: (m.kickoff_time as string) || '',
            status: 'in_play',
          };
          await runPhase4_InPlayMonitoring(env, matchInfo);
          console.log(`[Cron] Phase 4 (In-Play) complete for ${matchId}`);
        } catch (err) {
          console.error(`[Cron] Error in in-play monitoring for ${matchId}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Cron] Error fetching in-play matches:', err);
  }
}

/**
 * Cron 2 (every 30 minutes): Odds snapshot capture.
 * Captures odds for all scheduled and in-play matches.
 */
async function runScheduledOddsCapture(env: Env): Promise<void> {
  console.log('[Cron] Running odds snapshot capture');
  const db = getSupabase(env);

  // Get all matches that are scheduled or in-play (within a reasonable window)
  const now = new Date();
  const sixHoursLater = new Date(now.getTime() + 6 * 3600_000);
  const sixHoursAgo = new Date(now.getTime() - 6 * 3600_000);

  const { data: activeMatches, error } = await db
    .from('matches')
    .select('match_id, status, home_team, away_team, league, kickoff_time')
    .in('status', ['scheduled', 'in_play'])
    .gte('kickoff_time', sixHoursAgo.toISOString())
    .lte('kickoff_time', sixHoursLater.toISOString());

  if (error || !activeMatches) {
    console.error('[Cron] Error fetching active matches for odds:', error);
    return;
  }

  for (const m of activeMatches) {
    const matchId = m.match_id as string;
    try {
      const result = await captureOddsSnapshot(env, matchId);
      if (result.signals.length > 0) {
        console.log(`[Cron] ${result.signals.length} signals detected for ${matchId}`);
        // If match has a prediction and signals detected, trigger recalculation
        const prediction = await getLatestPrediction(db, matchId);
        if (prediction && !prediction.isLock) {
          const matchInfo: MatchInfo = {
            matchId,
            homeTeam: m.home_team as string,
            awayTeam: m.away_team as string,
            league: (m.league as string) || '',
            kickoffTime: (m.kickoff_time as string) || '',
            status: 'in_play',
          };
          await runPhase4_InPlayMonitoring(env, matchInfo);
        }
      }
    } catch (err) {
      // Odds API may fail for some matches - continue to next
      console.warn(`[Cron] Odds capture failed for ${matchId}:`, (err as Error).message);
    }
  }

  console.log(`[Cron] Odds capture complete for ${activeMatches.length} matches`);
}

/**
 * Cron 3 (every 6 hours): Post-match review.
 * Finds finished matches without reviews and processes them.
 */
async function runScheduledReview(env: Env): Promise<void> {
  console.log('[Cron] Running post-match review');
  const db = getSupabase(env);

  // First, fetch finished matches to update scores
  try {
    await fetchAndStoreFinishedMatches(env);
  } catch (err) {
    console.error('[Cron] Failed to fetch finished matches for review:', err);
  }

  // Get finished matches without reviews
  const matchesToReview = await getFinishedMatchesWithoutReview(db, 20);

  for (const match of matchesToReview) {
    try {
      // Determine actual result from scores
      const homeScore = match.homeScore ?? 0;
      const awayScore = match.awayScore ?? 0;
      let actualResult: MatchResult;
      if (homeScore > awayScore) actualResult = 'home_win';
      else if (homeScore < awayScore) actualResult = 'away_win';
      else actualResult = 'draw';

      const actualFt = `${homeScore}:${awayScore}`;
      const actualHt = match.halftimeHome !== undefined && match.halftimeAway !== undefined
        ? `${match.halftimeHome}:${match.halftimeAway}`
        : undefined;

      await runPostMatchReview(env, match.matchId, actualResult, actualFt, actualHt);
      console.log(`[Cron] Review complete for ${match.matchId}: ${actualResult} ${actualFt}`);
    } catch (err) {
      console.error(`[Cron] Review failed for ${match.matchId}:`, err);
    }
  }

  console.log(`[Cron] Post-match review complete: ${matchesToReview.length} matches reviewed`);
}

// ============================================================
// API Handlers
// ============================================================

async function handleCreateMatch(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as MatchInfo;
  if (!body.matchId || !body.homeTeam || !body.awayTeam) {
    return jsonResponse({ error: 'Missing required fields: matchId, homeTeam, awayTeam' }, cors, 400);
  }

  const db = getSupabase(env);
  await upsertMatch(db, {
    matchId: body.matchId,
    homeTeam: body.homeTeam,
    awayTeam: body.awayTeam,
    league: body.league || 'Unknown',
    leagueId: 0,
    season: new Date().getFullYear().toString(),
    kickoffTime: body.kickoffTime || new Date().toISOString(),
    status: body.status || 'scheduled',
    homeScore: body.homeScore,
    awayScore: body.awayScore,
    halftimeHome: body.halftimeHomeScore,
    halftimeAway: body.halftimeAwayScore,
  });

  return jsonResponse({ status: 'created', matchId: body.matchId }, cors);
}

async function handlePredict(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as MatchInfo;
  if (!body.matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  // Run full SOP pipeline
  const prediction = await runFullSOP(env, body);
  return jsonResponse({ prediction }, cors);
}

async function handleGetPredictions(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const matchId = url.searchParams.get('matchId');
  if (!matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const db = getSupabase(env);
  const prediction = await getLatestPrediction(db, matchId);
  return jsonResponse({ prediction }, cors);
}

/**
 * GET /api/all-predictions?limit=50
 * Returns all locked predictions, most recent first.
 */
async function handleGetAllPredictions(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const predictions = await getAllLockedPredictions(db, limit);
  return jsonResponse({ predictions }, cors);
}

async function handleGetPrediction(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const matchId = url.searchParams.get('matchId');
  if (!matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const db = getSupabase(env);
  const prediction = await getLockedPrediction(db, matchId);
  if (!prediction) {
    return jsonResponse({ error: 'No locked prediction found' }, cors, 404);
  }
  return jsonResponse({ prediction }, cors);
}

async function handleGetMatchFacts(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const matchId = url.searchParams.get('matchId');
  if (!matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const db = getSupabase(env);
  const facts = await getMatchFacts(db, matchId);
  return jsonResponse({ facts }, cors);
}

/**
 * GET /api/all-match-facts?limit=50
 * Returns all match facts, most recently updated first.
 */
async function handleGetAllMatchFacts(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const facts = await getAllMatchFacts(db, limit);
  return jsonResponse({ matches: facts }, cors);
}

async function handleCaptureOdds(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as { matchId: string };
  if (!body.matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const result = await captureOddsSnapshot(env, body.matchId);
  return jsonResponse(result, cors);
}

/**
 * GET /api/odds-snapshots?matchId=xxx&limit=50
 * Returns odds snapshots for a match, most recent first.
 */
async function handleGetOddsSnapshots(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const matchId = url.searchParams.get('matchId');
  if (!matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const db = getSupabase(env);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const snapshots = await getOddsSnapshots(db, matchId, limit);
  return jsonResponse({ snapshots }, cors);
}

async function handleReview(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as {
    matchId: string;
    actualResult: MatchResult;
    actualFt: string;
    actualHt?: string;
  };

  if (!body.matchId || !body.actualResult || !body.actualFt) {
    return jsonResponse({ error: 'matchId, actualResult, actualFt required' }, cors, 400);
  }

  const review = await runPostMatchReview(env, body.matchId, body.actualResult, body.actualFt, body.actualHt);
  return jsonResponse({ review }, cors);
}

async function handleGetReviews(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const matchId = url.searchParams.get('matchId');
  const limit = parseInt(url.searchParams.get('limit') || '20');

  if (matchId) {
    const reviews = await getReviewResults(db, matchId);
    return jsonResponse({ reviews }, cors);
  }

  const reviews = await getRecentReviews(db, limit);
  return jsonResponse({ reviews }, cors);
}

async function handleGetInPlay(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const matchId = url.searchParams.get('matchId');
  if (!matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const db = getSupabase(env);
  const predictions = await getInPlayPredictions(db, matchId);
  const oddsCount = await getOddsSnapshotCount(db, matchId);
  return jsonResponse({ inPlayPredictions: predictions, oddsSnapshotCount: oddsCount }, cors);
}

async function handleHealth(env: Env, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const { error } = await db.from('match_facts').select('match_id').limit(1);
  return jsonResponse({
    status: 'healthy',
    database: error ? 'error' : 'ok',
    timestamp: new Date().toISOString(),
  }, cors);
}

async function handleRunSOP(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as { match: MatchInfo; phase?: string };

  if (!body.match?.matchId) {
    return jsonResponse({ error: 'match.matchId required' }, cors, 400);
  }

  const phase = body.phase;

  let result: unknown;
  switch (phase) {
    case 'T0':
      await runPhase1_T0(env, body.match);
      result = { status: 'T0 complete' };
      break;
    case 'INITIAL':
      result = await runPhase2_Initial(env, body.match.matchId);
      break;
    case 'CROSS_DISCUSSION':
      result = await runPhase3_CrossDiscussion(env, body.match.matchId);
      break;
    case 'PERIODIC':
      result = await runPhase4_InPlayMonitoring(env, body.match);
      break;
    case 'FUSE':
      result = await runPhase5_FinalPublish(env, body.match.matchId);
      break;
    case 'FULL':
    default:
      result = await runFullSOP(env, body.match);
      break;
  }

  return jsonResponse({ result }, cors);
}

/**
 * POST /api/migrate
 * Creates the matches table if it doesn't exist.
 * This is needed because we can't run DDL via the Supabase REST API.
 */
async function handleRunMigration(env: Env, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);

  // Check if matches table exists by trying to query it
  const { error: checkError } = await db.from('matches').select('match_id').limit(1);

  if (checkError && (checkError.message.includes('does not exist') || checkError.message.includes('PGRST205'))) {
    // Table doesn't exist - create it via RPC
    // We need to create a function first that can run DDL
    // Actually, we can't run DDL via PostgREST. Let's create the table via a different approach.
    // We'll insert a helper function via the system_config approach
    
    // Try using Supabase's built-in exec function (if available)
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS matches (
        match_id        TEXT PRIMARY KEY,
        home_team       TEXT NOT NULL,
        away_team       TEXT NOT NULL,
        league          TEXT NOT NULL DEFAULT '',
        league_id       INTEGER,
        season          TEXT,
        kickoff_time    TIMESTAMPTZ NOT NULL,
        status          TEXT NOT NULL DEFAULT 'scheduled',
        home_score      INTEGER,
        away_score      INTEGER,
        halftime_home   INTEGER,
        halftime_away   INTEGER,
        round           TEXT,
        venue           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT chk_match_status CHECK (status IN ('scheduled', 'in_play', 'finished', 'cancelled', 'postponed'))
      );
      CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff_time, status);
      CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, kickoff_time);
      ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
      CREATE POLICY IF NOT EXISTS "service_role_all_matches" ON matches FOR ALL USING (auth.role() = 'service_role');
      CREATE TRIGGER IF NOT EXISTS trg_matches_updated
        BEFORE UPDATE ON matches
        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `;

    // We can't run DDL via REST. Return instructions.
    return jsonResponse({
      status: 'table_missing',
      message: 'matches table does not exist. Please run migration 003 in Supabase SQL Editor.',
      sql: createTableSQL,
      instructions: 'Go to Supabase Dashboard > SQL Editor, paste and run the SQL above.',
      supabase_url: 'https://supabase.com/dashboard/project/snycievdfcyoytthxspm/sql/new',
    }, cors, 200);
  }

  return jsonResponse({ status: 'ok', message: 'matches table already exists' }, cors);
}

async function handleGetConfig(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const key = url.searchParams.get('key');
  if (!key) {
    return jsonResponse({ error: 'key required' }, cors, 400);
  }
  const value = await getConfig(db, key);
  return jsonResponse({ key, value }, cors);
}

/**
 * GET /api/config/betting-window
 * Returns the current betting window configuration.
 */
async function handleGetBettingWindowConfig(env: Env, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const raw = await getConfig(db, 'betting_window_config');
  const config = mergeBettingWindowConfig(raw);
  return jsonResponse({ config }, cors);
}

/**
 * POST /api/config/betting-window
 * Updates the betting window configuration.
 * Body: partial BettingWindowConfig fields to update.
 */
async function handleUpdateBettingWindowConfig(
  request: Request, env: Env, cors: Record<string, string>
): Promise<Response> {
  const db = getSupabase(env);
  const body = await request.json() as Partial<BettingWindowConfig>;

  // Read current config
  const currentRaw = await getConfig(db, 'betting_window_config');
  const current = mergeBettingWindowConfig(currentRaw);

  // Merge updates
  const updated: BettingWindowConfig = {
    start_hours_before_kickoff: body.start_hours_before_kickoff ?? current.start_hours_before_kickoff,
    end_minutes_before_kickoff: body.end_minutes_before_kickoff ?? current.end_minutes_before_kickoff,
    fundamentals_delay_after_start_hours: body.fundamentals_delay_after_start_hours ?? current.fundamentals_delay_after_start_hours,
    final_lock_minutes_before_end: body.final_lock_minutes_before_end ?? current.final_lock_minutes_before_end,
    daily_active_start: body.daily_active_start ?? current.daily_active_start,
    daily_active_end: body.daily_active_end ?? current.daily_active_end,
    timezone: body.timezone ?? current.timezone,
    target_leagues: body.target_leagues ?? current.target_leagues,
    api_football_league_ids: body.api_football_league_ids ?? current.api_football_league_ids,
    season: body.season ?? current.season,
  };

  // Validate
  if (updated.start_hours_before_kickoff < 0.5 || updated.start_hours_before_kickoff > 24) {
    return jsonResponse({ error: 'start_hours_before_kickoff must be between 0.5 and 24' }, cors, 400);
  }
  if (updated.end_minutes_before_kickoff < 1 || updated.end_minutes_before_kickoff > 120) {
    return jsonResponse({ error: 'end_minutes_before_kickoff must be between 1 and 120' }, cors, 400);
  }
  if (updated.fundamentals_delay_after_start_hours < 0 || updated.fundamentals_delay_after_start_hours >= updated.start_hours_before_kickoff) {
    return jsonResponse({ error: 'fundamentals_delay_after_start_hours must be >= 0 and < start_hours_before_kickoff' }, cors, 400);
  }
  if (updated.final_lock_minutes_before_end < 0 || updated.final_lock_minutes_before_end > 120) {
    return jsonResponse({ error: 'final_lock_minutes_before_end must be between 0 and 120' }, cors, 400);
  }
  if (updated.start_hours_before_kickoff * 60 <= updated.end_minutes_before_kickoff) {
    return jsonResponse({ error: 'start window must be earlier than end window' }, cors, 400);
  }

  await setConfig(db, 'betting_window_config', updated);
  return jsonResponse({ config: updated, status: 'updated' }, cors);
}

// ============================================================
// Helpers
// ============================================================

/**
 * Authenticate write operations via Bearer token.
 * If ADMIN_API_KEY is not set, falls back to allowing all requests
 * (with a console warning) for backward compatibility during migration.
 */
function requireAuth(request: Request, env: Env, corsHeaders: Record<string, string>): Response | null {
  // If no admin key is configured, warn but allow (migration grace period)
  if (!env.ADMIN_API_KEY) {
    console.warn('[Auth] ADMIN_API_KEY not set - write operations are unauthenticated. Set ADMIN_API_KEY via wrangler secret.');
    return null;
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(
      { error: 'Unauthorized: missing or invalid Authorization header. Use: Bearer <token>' },
      corsHeaders,
      401
    );
  }

  const token = authHeader.slice(7);
  if (token !== env.ADMIN_API_KEY) {
    return jsonResponse(
      { error: 'Unauthorized: invalid token' },
      corsHeaders,
      401
    );
  }

  return null;
}

function jsonResponse(data: unknown, cors: Record<string, string>, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  });
}
