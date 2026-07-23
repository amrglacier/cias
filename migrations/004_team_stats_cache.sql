-- Migration 004: team_stats_cache
-- Caches static team statistics (xG, goals conceded, matches played, etc.)
-- to avoid redundant API-Football calls. Cache is valid for 12 hours.

CREATE TABLE IF NOT EXISTS team_stats_cache (
  cache_key TEXT PRIMARY KEY,          -- e.g. "2025_39_Arsenal"
  team_name TEXT NOT NULL,
  league_id INTEGER NOT NULL,
  season TEXT NOT NULL,
  xg_raw DOUBLE PRECISION DEFAULT 1.3,
  conc_raw DOUBLE PRECISION DEFAULT 1.3,
  matches_played INTEGER DEFAULT 10,
  opp_conc_rate DOUBLE PRECISION DEFAULT 1.3,
  opp_xg_rate DOUBLE PRECISION DEFAULT 1.3,
  league_avg_goals DOUBLE PRECISION DEFAULT 1.3,
  league_avg_conc DOUBLE PRECISION DEFAULT 1.3,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by team
CREATE INDEX IF NOT EXISTS idx_team_stats_cache_team
  ON team_stats_cache(team_name, league_id, season);

-- Enable RLS but allow public read (service key has full access)
ALTER TABLE team_stats_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on team_stats_cache"
  ON team_stats_cache FOR SELECT USING (true);
CREATE POLICY "Allow service role write on team_stats_cache"
  ON team_stats_cache FOR ALL USING (auth.role() = 'service_role');
