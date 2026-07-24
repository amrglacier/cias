// ============================================================
// CIAS - Database Repository Layer
// CRUD operations for all core tables
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  MatchFacts, OddsSnapshot, MarketSignal, Prediction,
  ReviewResult, WeightAdjustment, ApiUsage,
  MatchResult, VersionTag, AlignmentStatus,
  LogicTrace, KeyFactorMap, CrossDiscussionEntry,
  AttributionCode,
} from '../types';
import { SYSTEM_CONSTANTS } from '../config/defaults';

// ============================================================
// match_facts
// ============================================================
export async function upsertMatchFacts(db: SupabaseClient, facts: MatchFacts): Promise<MatchFacts> {
  const { data, error } = await db
    .from('match_facts')
    .upsert({
      match_id: facts.matchId,
      home_xg_adj: facts.homeXgAdj,
      away_xg_adj: facts.awayXgAdj,
      home_conc_adj: facts.homeConcAdj,
      away_conc_adj: facts.awayConcAdj,
      injury_impact_home: facts.injuryImpactHome,
      injury_impact_away: facts.injuryImpactAway,
      weather_decay: facts.weatherDecay,
      referee_strictness: facts.refereeStrictness,
      motivation_home: facts.motivationHome,
      motivation_away: facts.motivationAway,
      odds_zone: facts.oddsZone,
      bias_correction: facts.biasCorrection,
      formation_ctr_home: facts.formationCtrHome,
      formation_ctr_away: facts.formationCtrAway,
      data_confidence: facts.dataConfidence,
      league_avg_goals: facts.leagueAvgGoals,
      league_avg_conc: facts.leagueAvgConc,
      bayesian_prior_applied: facts.bayesianPriorApplied,
      status: facts.status,
    })
    .select()
    .single();
  if (error) throw new Error(`upsertMatchFacts: ${error.message}`);
  return mapMatchFacts(data);
}

export async function getMatchFacts(db: SupabaseClient, matchId: string): Promise<MatchFacts | null> {
  const { data, error } = await db
    .from('match_facts')
    .select('*')
    .eq('match_id', matchId)
    .maybeSingle();
  if (error) throw new Error(`getMatchFacts: ${error.message}`);
  return data ? mapMatchFacts(data) : null;
}

export async function updateMatchFactsStatus(db: SupabaseClient, matchId: string, status: string): Promise<void> {
  const { error } = await db
    .from('match_facts')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('match_id', matchId);
  if (error) throw new Error(`updateMatchFactsStatus: ${error.message}`);
}

// ============================================================
// odds_snapshots
// ============================================================
export async function insertOddsSnapshot(db: SupabaseClient, snap: OddsSnapshot): Promise<number> {
  const { data, error } = await db
    .from('odds_snapshots')
    .insert({
      match_id: snap.matchId,
      captured_at: snap.capturedAt,
      home_odds: snap.homeOdds,
      draw_odds: snap.drawOdds,
      away_odds: snap.awayOdds,
      source: snap.source,
      prev_home_odds: snap.prevHomeOdds,
      prev_draw_odds: snap.prevDrawOdds,
      prev_away_odds: snap.prevAwayOdds,
      move_pct_home: snap.movePctHome,
      move_pct_draw: snap.movePctDraw,
      move_pct_away: snap.movePctAway,
      signal_type: snap.signalType,
      is_sharp_move: snap.isSharpMove,
      is_steam_move: snap.isSteamMove,
    })
    .select()
    .single();
  if (error) throw new Error(`insertOddsSnapshot: ${error.message}`);
  return data.id;
}

export async function getLatestOddsSnapshot(db: SupabaseClient, matchId: string): Promise<OddsSnapshot | null> {
  const { data, error } = await db
    .from('odds_snapshots')
    .select('*')
    .eq('match_id', matchId)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestOddsSnapshot: ${error.message}`);
  return data ? mapOddsSnapshot(data) : null;
}

export async function getOddsSnapshotCount(db: SupabaseClient, matchId: string): Promise<number> {
  const { count, error } = await db
    .from('odds_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('match_id', matchId);
  if (error) throw new Error(`getOddsSnapshotCount: ${error.message}`);
  return count ?? 0;
}

// ============================================================
// market_signals
// ============================================================
export async function insertMarketSignal(db: SupabaseClient, signal: MarketSignal): Promise<string> {
  const { data, error } = await db
    .from('market_signals')
    .insert({
      id: signal.id,
      match_id: signal.matchId,
      signal_type: signal.signalType,
      description: signal.description,
      odds_snapshot_id: signal.oddsSnapshotId,
      detected_at: signal.detectedAt,
      metadata: signal.metadata,
    })
    .select()
    .single();
  if (error) throw new Error(`insertMarketSignal: ${error.message}`);
  return data.id;
}

export async function getMarketSignals(db: SupabaseClient, matchId: string, since?: string): Promise<MarketSignal[]> {
  let query = db
    .from('market_signals')
    .select('*')
    .eq('match_id', matchId)
    .order('detected_at', { ascending: false });
  if (since) {
    query = query.gte('detected_at', since);
  }
  const { data, error } = await query;
  if (error) throw new Error(`getMarketSignals: ${error.message}`);
  return (data ?? []).map(mapMarketSignal);
}

// ============================================================
// predictions
// ============================================================
export async function insertPrediction(db: SupabaseClient, pred: Prediction): Promise<number> {
  const { data, error } = await db
    .from('predictions')
    .insert({
      match_id: pred.matchId,
      primary_result: pred.primaryResult,
      primary_ft: pred.primaryFt,
      primary_ht: pred.primaryHt,
      hedge_result: pred.hedgeResult,
      hedge_ft: pred.hedgeFt,
      hedge_ht: pred.hedgeHt,
      direction_judgment: pred.directionJudgment,
      version_tag: pred.versionTag,
      is_archived: pred.isArchived,
      snapshot_id: pred.snapshotId,
      prev_version_id: pred.prevVersionId,
      market_signal_ids: pred.marketSignalIds,
      delta_explanation: pred.deltaExplanation,
      logic_trace: pred.logicTrace,
      key_factors: pred.keyFactors,
      is_lock: pred.isLock,
      alignment_status: pred.alignmentStatus,
      alignment_forced_degrade: pred.alignmentForcedDegrade,
      cross_discussion_log: pred.crossDiscussionLog,
    })
    .select()
    .single();
  if (error) throw new Error(`insertPrediction: ${error.message}`);
  return data.id;
}

export async function getLatestPrediction(db: SupabaseClient, matchId: string): Promise<Prediction | null> {
  const { data, error } = await db
    .from('predictions')
    .select('*')
    .eq('match_id', matchId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestPrediction: ${error.message}`);
  return data ? mapPrediction(data) : null;
}

export async function getPredictionById(db: SupabaseClient, predId: number): Promise<Prediction | null> {
  const { data, error } = await db
    .from('predictions')
    .select('*')
    .eq('id', predId)
    .maybeSingle();
  if (error) throw new Error(`getPredictionById: ${error.message}`);
  return data ? mapPrediction(data) : null;
}

export async function getLockedPrediction(db: SupabaseClient, matchId: string): Promise<Prediction | null> {
  const { data, error } = await db
    .from('predictions')
    .select('*')
    .eq('match_id', matchId)
    .eq('is_lock', true)
    .maybeSingle();
  if (error) throw new Error(`getLockedPrediction: ${error.message}`);
  return data ? mapPrediction(data) : null;
}

export async function getInPlayPredictions(db: SupabaseClient, matchId: string): Promise<Prediction[]> {
  const { data, error } = await db
    .from('predictions')
    .select('*')
    .eq('match_id', matchId)
    .eq('version_tag', 'PERIODIC')
    .order('created_at', { ascending: false })
    .limit(SYSTEM_CONSTANTS.INPLAY_MAX_RECORDS + 1);
  if (error) throw new Error(`getInPlayPredictions: ${error.message}`);
  return (data ?? []).map(mapPrediction);
}

// Atomic deletion of oldest in-play records (SRS 3.3 - Atomic Delete)
export async function atomicDeleteOldestInPlay(
  db: SupabaseClient,
  matchId: string
): Promise<number> {
  // SRS mandates: DELETE ... ORDER BY created_at ASC LIMIT 1
  // Supabase JS doesn't support ORDER BY in delete, so we use rpc
  const { data, error } = await db.rpc('delete_oldest_inplay_prediction', {
    p_match_id: matchId,
    p_limit: SYSTEM_CONSTANTS.CLEANUP_OLDEST_LIMIT,
  });
  if (error) {
    // Fallback: manual delete with SELECT then DELETE (less atomic)
    const { data: oldest } = await db
      .from('predictions')
      .select('id')
      .eq('match_id', matchId)
      .eq('version_tag', 'PERIODIC')
      .order('created_at', { ascending: true })
      .limit(SYSTEM_CONSTANTS.CLEANUP_OLDEST_LIMIT);
    if (oldest && oldest.length > 0) {
      const ids = oldest.map((r: { id: number }) => r.id);
      const { error: delError } = await db
        .from('predictions')
        .delete()
        .in('id', ids);
      if (delError) throw new Error(`atomicDeleteOldestInPlay fallback: ${delError.message}`);
      return ids.length;
    }
    return 0;
  }
  return data ?? 0;
}

export async function archivePrediction(db: SupabaseClient, predId: number): Promise<void> {
  const { error } = await db
    .from('predictions')
    .update({ is_archived: true })
    .eq('id', predId);
  if (error) throw new Error(`archivePrediction: ${error.message}`);
}

export async function lockPrediction(db: SupabaseClient, predId: number): Promise<void> {
  const { error } = await db
    .from('predictions')
    .update({ is_lock: true, version_tag: 'FINAL' })
    .eq('id', predId);
  if (error) throw new Error(`lockPrediction: ${error.message}`);
}

// ============================================================
// api_usage_log (for circuit breaker)
// ============================================================
export async function logApiUsage(db: SupabaseClient, usage: ApiUsage): Promise<void> {
  const { error } = await db.from('api_usage_log').insert({
    api_name: usage.apiName,
    endpoint: usage.endpoint,
    called_at: usage.calledAt,
    remaining: usage.remaining,
    total: usage.total,
    used: usage.used,
  });
  if (error) throw new Error(`logApiUsage: ${error.message}`);
}

export async function getLatestApiUsage(db: SupabaseClient, apiName: string): Promise<ApiUsage | null> {
  const { data, error } = await db
    .from('api_usage_log')
    .select('*')
    .eq('api_name', apiName)
    .order('called_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestApiUsage: ${error.message}`);
  if (!data) return null;
  return {
    apiName: data.api_name,
    endpoint: data.endpoint,
    calledAt: data.called_at,
    remaining: data.remaining,
    total: data.total,
    used: data.used,
  };
}

// ============================================================
// review_results
// ============================================================
export async function insertReviewResult(db: SupabaseClient, review: ReviewResult): Promise<number> {
  const { data, error } = await db
    .from('review_results')
    .insert({
      match_id: review.matchId,
      prediction_id: review.predictionId,
      actual_result: review.actualResult,
      actual_ft: review.actualFt,
      actual_ht: review.actualHt,
      attribution_code: review.attributionCode,
      attribution_party: review.attributionParty,
      attribution_detail: review.attributionDetail,
      error_type: review.errorType,
      is_upset: review.isUpset,
    })
    .select()
    .single();
  if (error) throw new Error(`insertReviewResult: ${error.message}`);
  return data.id;
}

export async function getReviewResults(db: SupabaseClient, matchId: string): Promise<ReviewResult[]> {
  const { data, error } = await db
    .from('review_results')
    .select('*')
    .eq('match_id', matchId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getReviewResults: ${error.message}`);
  return (data ?? []).map(mapReviewResult);
}

export async function getRecentReviews(db: SupabaseClient, limit: number = 20): Promise<ReviewResult[]> {
  const { data, error } = await db
    .from('review_results')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getRecentReviews: ${error.message}`);
  return (data ?? []).map(mapReviewResult);
}

// ============================================================
// weight_adjustments
// ============================================================
export async function insertWeightAdjustment(db: SupabaseClient, adj: WeightAdjustment): Promise<number> {
  const { data, error } = await db
    .from('weight_adjustments')
    .insert({
      factor_id: adj.factorId,
      factor_name: adj.factorName,
      old_weight: adj.oldWeight,
      new_weight: adj.newWeight,
      adjustment_pct: adj.adjustmentPct,
      trigger_reason: adj.triggerReason,
      match_count: adj.matchCount,
    })
    .select()
    .single();
  if (error) throw new Error(`insertWeightAdjustment: ${error.message}`);
  return data.id;
}

// ============================================================
// system_config
// ============================================================
export async function getConfig(db: SupabaseClient, key: string): Promise<unknown | null> {
  const { data, error } = await db
    .from('system_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`getConfig: ${error.message}`);
  return data?.value ?? null;
}

export async function setConfig(db: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await db
    .from('system_config')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`setConfig: ${error.message}`);
}

// ============================================================
// matches (fixture tracking)
// ============================================================
export interface MatchRow {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  leagueId?: number;
  season?: string;
  kickoffTime: string;
  status: 'scheduled' | 'in_play' | 'finished' | 'cancelled' | 'postponed';
  homeScore?: number;
  awayScore?: number;
  halftimeHome?: number;
  halftimeAway?: number;
  round?: string;
  venue?: string;
}

export async function upsertMatch(db: SupabaseClient, m: MatchRow): Promise<void> {
  const { error } = await db.from('matches').upsert({
    match_id: m.matchId,
    home_team: m.homeTeam,
    away_team: m.awayTeam,
    league: m.league,
    league_id: m.leagueId,
    season: m.season,
    kickoff_time: m.kickoffTime,
    status: m.status,
    home_score: m.homeScore,
    away_score: m.awayScore,
    halftime_home: m.halftimeHome,
    halftime_away: m.halftimeAway,
    round: m.round,
    venue: m.venue,
  });
  if (error) throw new Error(`upsertMatch: ${error.message}`);
}

export async function getMatch(db: SupabaseClient, matchId: string): Promise<MatchRow | null> {
  const { data, error } = await db
    .from('matches')
    .select('*')
    .eq('match_id', matchId)
    .maybeSingle();
  if (error) throw new Error(`getMatch: ${error.message}`);
  return data ? mapMatchRow(data) : null;
}

export async function getUpcomingMatches(db: SupabaseClient, withinHours: number): Promise<MatchRow[]> {
  const now = new Date();
  const later = new Date(now.getTime() + withinHours * 3600_000);
  const { data, error } = await db
    .from('matches')
    .select('*')
    .eq('status', 'scheduled')
    .gte('kickoff_time', now.toISOString())
    .lte('kickoff_time', later.toISOString())
    .order('kickoff_time', { ascending: true });
  if (error) throw new Error(`getUpcomingMatches: ${error.message}`);
  return (data ?? []).map(mapMatchRow);
}

export async function getFinishedMatchesWithoutReview(db: SupabaseClient, limit: number = 50): Promise<MatchRow[]> {
  // Fetch more records than needed because some may have reviews.
  // The application-layer filter below removes reviewed matches.
  // TODO: Replace with Postgres `NOT EXISTS` RPC for DB-level filtering.
  const fetchLimit = Math.max(limit * 5, 200);

  const { data: finished, error: err1 } = await db
    .from('matches')
    .select('*')
    .eq('status', 'finished')
    .order('kickoff_time', { ascending: false })
    .limit(fetchLimit);

  if (err1) throw new Error(`getFinishedMatchesWithoutReview: ${err1.message}`);
  if (!finished || finished.length === 0) return [];

  const matchIds = finished.map(m => m.match_id);

  // Find which of these already have reviews
  const { data: reviewed, error: err2 } = await db
    .from('review_results')
    .select('match_id')
    .in('match_id', matchIds);

  if (err2) throw new Error(`getFinishedMatchesWithoutReview: ${err2.message}`);

  const reviewedSet = new Set((reviewed ?? []).map(r => r.match_id));
  const result = finished.filter(m => !reviewedSet.has(m.match_id)).slice(0, limit).map(mapMatchRow);

  if (result.length < limit && finished.length === fetchLimit) {
    console.warn(`[Repository] getFinishedMatchesWithoutReview: may have missed matches. Consider increasing fetchLimit or adding DB-level NOT EXISTS filter.`);
  }

  return result;
}

export async function updateMatchStatus(
  db: SupabaseClient, matchId: string, status: string,
  homeScore?: number, awayScore?: number,
  halftimeHome?: number, halftimeAway?: number
): Promise<void> {
  const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (homeScore !== undefined) update.home_score = homeScore;
  if (awayScore !== undefined) update.away_score = awayScore;
  if (halftimeHome !== undefined) update.halftime_home = halftimeHome;
  if (halftimeAway !== undefined) update.halftime_away = halftimeAway;
  const { error } = await db.from('matches').update(update).eq('match_id', matchId);
  if (error) throw new Error(`updateMatchStatus: ${error.message}`);
}

function mapMatchRow(d: Record<string, unknown>): MatchRow {
  return {
    matchId: d.match_id as string,
    homeTeam: d.home_team as string,
    awayTeam: d.away_team as string,
    league: d.league as string,
    leagueId: d.league_id as number | undefined,
    season: d.season as string | undefined,
    kickoffTime: d.kickoff_time as string,
    status: d.status as MatchRow['status'],
    homeScore: d.home_score as number | undefined,
    awayScore: d.away_score as number | undefined,
    halftimeHome: d.halftime_home as number | undefined,
    halftimeAway: d.halftime_away as number | undefined,
    round: d.round as string | undefined,
    venue: d.venue as string | undefined,
  };
}

// ============================================================
// error_count
// ============================================================
export async function logError(db: SupabaseClient, factorId: string, errorType: string, matchId: string): Promise<void> {
  const { error } = await db.from('error_count').insert({
    factor_id: factorId,
    error_type: errorType,
    match_id: matchId,
  });
  if (error) throw new Error(`logError: ${error.message}`);
}

export async function getErrorCount(db: SupabaseClient, factorId: string, errorType: string): Promise<number> {
  const { count, error } = await db
    .from('error_count')
    .select('*', { count: 'exact', head: true })
    .eq('factor_id', factorId)
    .eq('error_type', errorType);
  if (error) throw new Error(`getErrorCount: ${error.message}`);
  return count ?? 0;
}

export async function clearErrorCount(db: SupabaseClient, factorId: string, errorType: string): Promise<void> {
  const { error } = await db
    .from('error_count')
    .delete()
    .eq('factor_id', factorId)
    .eq('error_type', errorType);
  if (error) throw new Error(`clearErrorCount: ${error.message}`);
}

// ============================================================
// Bulk queries (for frontend list views)
// ============================================================

export async function getAllLockedPredictions(db: SupabaseClient, limit: number = 50): Promise<Prediction[]> {
  const { data, error } = await db
    .from('predictions')
    .select('*')
    .eq('is_lock', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getAllLockedPredictions: ${error.message}`);
  return (data ?? []).map(mapPrediction);
}

export async function getOddsSnapshots(db: SupabaseClient, matchId: string, limit: number = 50): Promise<OddsSnapshot[]> {
  const { data, error } = await db
    .from('odds_snapshots')
    .select('*')
    .eq('match_id', matchId)
    .order('captured_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getOddsSnapshots: ${error.message}`);
  return (data ?? []).map(mapOddsSnapshot);
}

export async function getAllMatchFacts(db: SupabaseClient, limit: number = 50): Promise<MatchFacts[]> {
  const { data, error } = await db
    .from('match_facts')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getAllMatchFacts: ${error.message}`);
  return (data ?? []).map(mapMatchFacts);
}

// ============================================================
// Mapping helpers (DB snake_case -> camelCase)
// ============================================================
function mapMatchFacts(d: Record<string, unknown>): MatchFacts {
  return {
    matchId: d.match_id as string,
    homeXgAdj: d.home_xg_adj as number | undefined,
    awayXgAdj: d.away_xg_adj as number | undefined,
    homeConcAdj: d.home_conc_adj as number | undefined,
    awayConcAdj: d.away_conc_adj as number | undefined,
    injuryImpactHome: d.injury_impact_home as number,
    injuryImpactAway: d.injury_impact_away as number,
    weatherDecay: d.weather_decay as number,
    refereeStrictness: d.referee_strictness as number,
    motivationHome: d.motivation_home as number,
    motivationAway: d.motivation_away as number,
    oddsZone: d.odds_zone as string | undefined,
    biasCorrection: d.bias_correction as number,
    formationCtrHome: d.formation_ctr_home as number,
    formationCtrAway: d.formation_ctr_away as number,
    dataConfidence: d.data_confidence as number,
    leagueAvgGoals: d.league_avg_goals as number,
    leagueAvgConc: d.league_avg_conc as number,
    bayesianPriorApplied: d.bayesian_prior_applied as boolean,
    status: d.status as string,
    createdAt: d.created_at as string,
    updatedAt: d.updated_at as string,
  };
}

function mapOddsSnapshot(d: Record<string, unknown>): OddsSnapshot {
  return {
    id: d.id as number,
    matchId: d.match_id as string,
    capturedAt: d.captured_at as string,
    homeOdds: d.home_odds as number,
    drawOdds: d.draw_odds as number,
    awayOdds: d.away_odds as number,
    source: d.source as string,
    prevHomeOdds: d.prev_home_odds as number | undefined,
    prevDrawOdds: d.prev_draw_odds as number | undefined,
    prevAwayOdds: d.prev_away_odds as number | undefined,
    movePctHome: d.move_pct_home as number | undefined,
    movePctDraw: d.move_pct_draw as number | undefined,
    movePctAway: d.move_pct_away as number | undefined,
    signalType: d.signal_type as string | undefined,
    isSharpMove: d.is_sharp_move as boolean | undefined,
    isSteamMove: d.is_steam_move as boolean | undefined,
  };
}

function mapMarketSignal(d: Record<string, unknown>): MarketSignal {
  return {
    id: d.id as string,
    matchId: d.match_id as string,
    signalType: d.signal_type as MarketSignal['signalType'],
    description: d.description as string,
    oddsSnapshotId: d.odds_snapshot_id as number | undefined,
    detectedAt: d.detected_at as string,
    metadata: d.metadata as MarketSignal['metadata'],
  };
}

function mapPrediction(d: Record<string, unknown>): Prediction {
  return {
    id: d.id as number,
    matchId: d.match_id as string,
    primaryResult: d.primary_result as MatchResult,
    primaryFt: d.primary_ft as string,
    primaryHt: d.primary_ht as string | undefined,
    hedgeResult: d.hedge_result as MatchResult | undefined,
    hedgeFt: d.hedge_ft as string | undefined,
    hedgeHt: d.hedge_ht as string | undefined,
    directionJudgment: d.direction_judgment as string,
    versionTag: d.version_tag as VersionTag,
    isArchived: d.is_archived as boolean,
    snapshotId: d.snapshot_id as number | undefined,
    prevVersionId: d.prev_version_id as number | undefined,
    marketSignalIds: (d.market_signal_ids ?? []) as string[],
    deltaExplanation: d.delta_explanation as string | undefined,
    logicTrace: d.logic_trace as LogicTrace,
    keyFactors: d.key_factors as KeyFactorMap,
    isLock: d.is_lock as boolean,
    alignmentStatus: d.alignment_status as AlignmentStatus,
    alignmentForcedDegrade: d.alignment_forced_degrade as boolean,
    crossDiscussionLog: (d.cross_discussion_log ?? []) as CrossDiscussionEntry[],
    createdAt: d.created_at as string,
  };
}

function mapReviewResult(d: Record<string, unknown>): ReviewResult {
  return {
    id: d.id as number,
    matchId: d.match_id as string,
    predictionId: d.prediction_id as number,
    actualResult: d.actual_result as MatchResult,
    actualFt: d.actual_ft as string | undefined,
    actualHt: d.actual_ht as string | undefined,
    attributionCode: d.attribution_code as AttributionCode,
    attributionParty: d.attribution_party as 'data' | 'logic',
    attributionDetail: d.attribution_detail as string,
    errorType: d.error_type as string,
    isUpset: d.is_upset as boolean,
    createdAt: d.created_at as string,
  };
}
