-- ============================================================
-- CIAS - Migration 003: Matches table + Betting window config
-- Adds matches table for fixture tracking and betting time config
-- ============================================================

-- ============================================================
-- matches table (fixture tracking from API-Football)
-- ============================================================
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

-- RLS
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_matches" ON matches FOR ALL USING (auth.role() = 'service_role');

-- Trigger for updated_at
CREATE TRIGGER trg_matches_updated
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Betting window config (system_config)
-- ============================================================
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
