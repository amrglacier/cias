-- ============================================================
-- CIAS - Supabase Migration: Core Tables
-- Version: 1.4.2-SRS-FULL-PROD
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. match_facts (基本面事实表)
-- ============================================================
CREATE TABLE IF NOT EXISTS match_facts (
  match_id           TEXT PRIMARY KEY,
  home_xg_adj        DOUBLE PRECISION,
  away_xg_adj        DOUBLE PRECISION,
  home_conc_adj      DOUBLE PRECISION,
  away_conc_adj      DOUBLE PRECISION,
  injury_impact_home DOUBLE PRECISION DEFAULT 0,
  injury_impact_away DOUBLE PRECISION DEFAULT 0,
  weather_decay      DOUBLE PRECISION DEFAULT 1.0,
  referee_strictness DOUBLE PRECISION DEFAULT 0,
  motivation_home    DOUBLE PRECISION DEFAULT 1.0,
  motivation_away    DOUBLE PRECISION DEFAULT 1.0,
  odds_zone          TEXT,
  bias_correction    DOUBLE PRECISION DEFAULT 0,
  formation_ctr_home DOUBLE PRECISION DEFAULT 0,
  formation_ctr_away DOUBLE PRECISION DEFAULT 0,
  data_confidence    DOUBLE PRECISION DEFAULT 0.5,
  league_avg_goals   DOUBLE PRECISION DEFAULT 1.3,
  league_avg_conc    DOUBLE PRECISION DEFAULT 1.3,
  bayesian_prior_applied BOOLEAN DEFAULT FALSE,
  status             TEXT DEFAULT 'pending',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. odds_snapshots (赔率快照表)
-- ============================================================
CREATE TABLE IF NOT EXISTS odds_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  match_id    TEXT NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT NOW(),
  home_odds   DOUBLE PRECISION,
  draw_odds   DOUBLE PRECISION,
  away_odds   DOUBLE PRECISION,
  source      TEXT DEFAULT 'odds_api',
  -- Sharp/Steam detection metadata
  prev_home_odds DOUBLE PRECISION,
  prev_draw_odds DOUBLE PRECISION,
  prev_away_odds DOUBLE PRECISION,
  move_pct_home  DOUBLE PRECISION DEFAULT 0,
  move_pct_draw  DOUBLE PRECISION DEFAULT 0,
  move_pct_away  DOUBLE PRECISION DEFAULT 0,
  signal_type    TEXT,
  is_sharp_move  BOOLEAN DEFAULT FALSE,
  is_steam_move  BOOLEAN DEFAULT FALSE,
  CONSTRAINT fk_odds_match FOREIGN KEY (match_id) REFERENCES match_facts(match_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_odds_match_time ON odds_snapshots(match_id, captured_at DESC);

-- ============================================================
-- 3. market_signals (市场信号表)
-- ============================================================
CREATE TABLE IF NOT EXISTS market_signals (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  match_id        TEXT NOT NULL,
  signal_type     TEXT NOT NULL,
  description     TEXT,
  odds_snapshot_id BIGINT,
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'::JSONB,
  CONSTRAINT fk_signal_match FOREIGN KEY (match_id) REFERENCES match_facts(match_id) ON DELETE CASCADE,
  CONSTRAINT fk_signal_odds FOREIGN KEY (odds_snapshot_id) REFERENCES odds_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_market_signals_match ON market_signals(match_id, detected_at DESC);

-- ============================================================
-- 4. predictions (预测表)
-- ============================================================
CREATE TABLE IF NOT EXISTS predictions (
  id                  BIGSERIAL PRIMARY KEY,
  match_id            TEXT NOT NULL,
  primary_result      TEXT,
  primary_ft          TEXT,
  primary_ht          TEXT,
  hedge_result        TEXT,
  hedge_ft            TEXT,
  hedge_ht             TEXT,
  direction_judgment  TEXT,
  version_tag         TEXT NOT NULL DEFAULT 'INITIAL',
  is_archived         BOOLEAN DEFAULT FALSE,
  snapshot_id         BIGINT,
  prev_version_id     BIGINT,
  market_signal_ids   JSONB DEFAULT '[]'::JSONB,
  delta_explanation   TEXT,
  logic_trace         JSONB DEFAULT '{}'::JSONB,
  key_factors         JSONB DEFAULT '{}'::JSONB,
  is_lock             BOOLEAN DEFAULT FALSE,
  alignment_status    TEXT DEFAULT 'pending',
  alignment_forced_degrade BOOLEAN DEFAULT FALSE,
  cross_discussion_log JSONB DEFAULT '[]'::JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  -- Constitutional constraint: non-stone-cold picks must have hedge
  CONSTRAINT chk_hedge_required CHECK (
    is_lock = TRUE OR hedge_result IS NOT NULL
  ),
  CONSTRAINT chk_version_tag CHECK (
    version_tag IN ('INITIAL', 'PERIODIC', 'FINAL')
  ),
  CONSTRAINT fk_pred_match FOREIGN KEY (match_id) REFERENCES match_facts(match_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_predictions_match_version
  ON predictions(match_id, version_tag, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_cleanup
  ON predictions(match_id, version_tag, is_archived, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_lock
  ON predictions(match_id, is_lock, created_at DESC) WHERE is_lock = TRUE;

-- ============================================================
-- 5. api_usage_log (API usage tracking for circuit breaker)
-- ============================================================
CREATE TABLE IF NOT EXISTS api_usage_log (
  id          BIGSERIAL PRIMARY KEY,
  api_name    TEXT NOT NULL,
  endpoint    TEXT,
  called_at   TIMESTAMPTZ DEFAULT NOW(),
  remaining   INTEGER,
  total       INTEGER,
  used        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_usage_latest ON api_usage_log(api_name, called_at DESC);

-- ============================================================
-- 6. review_results (复盘子系统)
-- ============================================================
CREATE TABLE IF NOT EXISTS review_results (
  id                  BIGSERIAL PRIMARY KEY,
  match_id            TEXT NOT NULL,
  prediction_id      BIGINT NOT NULL,
  actual_result       TEXT,
  actual_ft           TEXT,
  actual_ht           TEXT,
  attribution_code    TEXT,
  attribution_party   TEXT,
  attribution_detail  TEXT,
  error_type          TEXT,
  is_upset            BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_review_match FOREIGN KEY (match_id) REFERENCES match_facts(match_id) ON DELETE CASCADE,
  CONSTRAINT fk_review_pred FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE,
  CONSTRAINT chk_attribution_code CHECK (
    attribution_code IN ('A1','A2','C1','C2','D1','D2','D3','D4')
  )
);

CREATE INDEX IF NOT EXISTS idx_review_match ON review_results(match_id);

-- ============================================================
-- 7. weight_adjustments (权重迭代记录)
-- ============================================================
CREATE TABLE IF NOT EXISTS weight_adjustments (
  id              BIGSERIAL PRIMARY KEY,
  factor_id       TEXT NOT NULL,
  factor_name     TEXT NOT NULL,
  old_weight      DOUBLE PRECISION,
  new_weight      DOUBLE PRECISION,
  adjustment_pct  DOUBLE PRECISION,
  trigger_reason  TEXT,
  match_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_adjustment_pct CHECK (adjustment_pct <= 10.0)
);

CREATE INDEX IF NOT EXISTS idx_weight_adj_factor ON weight_adjustments(factor_id, created_at DESC);

-- ============================================================
-- 8. system_config (系统配置 - persistent weight store)
-- ============================================================
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default factor weights
INSERT INTO system_config (key, value) VALUES
  ('factor_weights', '{
    "w1": 0.35, "w2": 0.25, "w3": 0.20, "w4": 0.10,
    "inj_home": 0.15, "inj_away": 0.15,
    "weather_decay_min": 0.95, "weather_decay_max": 1.0,
    "ref_strictness_step": 0.02,
    "motiv_min": 0.9, "motiv_max": 1.1,
    "bias_zone_min": -0.05, "bias_zone_max": 0.03,
    "mkt_sig_range": 0.04,
    "form_ctr_range": 0.03
  }'::JSONB),
  ('review_config', '{
    "hitrate_threshold": 30,
    "trend_error_count": 3,
    "adjustment_max_pct": 10
  }'::JSONB)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 9. error_count (continuous error tracking for weight iteration)
-- ============================================================
CREATE TABLE IF NOT EXISTS error_count (
  id          BIGSERIAL PRIMARY KEY,
  factor_id   TEXT NOT NULL,
  error_type  TEXT NOT NULL,
  match_id    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_count_factor ON error_count(factor_id, error_type, created_at DESC);

-- ============================================================
-- Auto-update updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_match_facts_updated
  BEFORE UPDATE ON match_facts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_system_config_updated
  BEFORE UPDATE ON system_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Row Level Security (Supabase)
-- ============================================================
ALTER TABLE match_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_count ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; create permissive policy for service key access
CREATE POLICY "service_role_all_match_facts" ON match_facts FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_odds" ON odds_snapshots FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_signals" ON market_signals FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_predictions" ON predictions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_api_usage" ON api_usage_log FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_review" ON review_results FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_weight_adj" ON weight_adjustments FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_config" ON system_config FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_error_count" ON error_count FOR ALL USING (auth.role() = 'service_role');
