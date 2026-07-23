-- ============================================================
-- CIAS - Matches Table Creation Script
-- Run this in Supabase Dashboard > SQL Editor
-- ============================================================

-- Step 1: Create update_updated_at function if not exists
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 2: Create matches table
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

-- Step 3: Create indexes
CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff_time, status);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, kickoff_time);

-- Step 4: Enable RLS
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_matches" ON matches FOR ALL USING (auth.role() = 'service_role');

-- Step 5: Create trigger for updated_at
DROP TRIGGER IF EXISTS trg_matches_updated ON matches;
CREATE TRIGGER trg_matches_updated
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Step 6: Insert betting window config (if not exists)
INSERT INTO system_config (key, value) VALUES
  ('betting_window_config', '{
    "start_hours_before_kickoff": 2,
    "end_minutes_before_kickoff": 15,
    "daily_active_start": "06:00",
    "daily_active_end": "23:59",
    "timezone": "Asia/Shanghai",
    "target_leagues": ["soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a", "soccer_germany_bundesliga", "soccer_france_ligue_one"],
    "api_football_league_ids": [39, 140, 135, 78, 61],
    "season": "2025"
  }'::JSONB)
ON CONFLICT (key) DO NOTHING;
