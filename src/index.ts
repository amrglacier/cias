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
import { getSupabase } from './db/client';
import {
  getMatchFacts, getLatestPrediction, getLockedPrediction,
  getInPlayPredictions, getReviewResults, getRecentReviews,
  getOddsSnapshotCount, getConfig,
} from './db/repository';
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

    try {
      // API Routes
      switch (path) {
        case '/':
          return jsonResponse({ status: 'ok', system: 'CIAS', version: '1.4.2' }, corsHeaders);

        case '/api/matches':
          return await handleCreateMatch(request, env, corsHeaders);

        case '/api/predict':
          return await handlePredict(request, env, corsHeaders);

        case '/api/predictions':
          return await handleGetPredictions(request, env, url, corsHeaders);

        case '/api/prediction':
          return await handleGetPrediction(request, env, url, corsHeaders);

        case '/api/match-facts':
          return await handleGetMatchFacts(env, url, corsHeaders);

        case '/api/odds-snapshot':
          return await handleCaptureOdds(request, env, corsHeaders);

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
    } else if (event.cron === '*/15 * * * *') {
      // Odds snapshot capture every 15 minutes
      await runScheduledOddsCapture(env);
    } else if (event.cron === '0 */6 * * *') {
      // Post-match review every 6 hours
      await runScheduledReview(env);
    }
  },
};

// ============================================================
// Scheduled Job Handlers
// ============================================================

async function runScheduledFundamentalsAndMonitoring(env: Env): Promise<void> {
  // In production: fetch upcoming matches from DB or API
  // For each match in the pre-match window:
  //   - If not yet in T0: run Phase 1 + 2 + 3
  //   - If in-play: run Phase 4

  console.log('[Cron] Running fundamentals + monitoring cycle');
  // Implementation would iterate over active matches
}

async function runScheduledOddsCapture(env: Env): Promise<void> {
  console.log('[Cron] Running odds snapshot capture');
  // Iterate over active matches and capture odds
}

async function runScheduledReview(env: Env): Promise<void> {
  console.log('[Cron] Running post-match review');
  // Find finished matches without review and process them
}

// ============================================================
// API Handlers
// ============================================================

async function handleCreateMatch(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as MatchInfo;
  if (!body.matchId || !body.homeTeam || !body.awayTeam) {
    return jsonResponse({ error: 'Missing required fields' }, cors, 400);
  }

  // Store match info (would insert into a matches table in production)
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

async function handleCaptureOdds(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const body = await request.json() as { matchId: string };
  if (!body.matchId) {
    return jsonResponse({ error: 'matchId required' }, cors, 400);
  }

  const result = await captureOddsSnapshot(env, body.matchId);
  return jsonResponse(result, cors);
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
      result = await runPhase4_InPlayMonitoring(env, body.match.matchId);
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

async function handleGetConfig(env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
  const db = getSupabase(env);
  const key = url.searchParams.get('key');
  if (!key) {
    return jsonResponse({ error: 'key required' }, cors, 400);
  }
  const value = await getConfig(db, key);
  return jsonResponse({ key, value }, cors);
}

// ============================================================
// Helpers
// ============================================================

function jsonResponse(data: unknown, cors: Record<string, string>, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  });
}
