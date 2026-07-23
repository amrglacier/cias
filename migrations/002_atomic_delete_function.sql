-- ============================================================
-- CIAS - Migration 002: Atomic Delete Function
-- SRS 3.3: Atomic DELETE ... ORDER BY created_at ASC LIMIT 1
-- ============================================================

CREATE OR REPLACE FUNCTION delete_oldest_inplay_prediction(
  p_match_id TEXT,
  p_limit INTEGER DEFAULT 1
)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- SRS 3.3: Atomic single-statement deletion
  -- Must use DELETE ... ORDER BY ... LIMIT to avoid race conditions
  WITH oldest AS (
    SELECT id FROM predictions
    WHERE match_id = p_match_id
      AND version_tag = 'PERIODIC'
      AND is_archived = FALSE
    ORDER BY created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED  -- Skip locked rows to avoid deadlock
  )
  DELETE FROM predictions
  WHERE id IN (SELECT id FROM oldest);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- View: Latest Predictions per Match (for frontend)
-- ============================================================
CREATE OR REPLACE VIEW v_latest_predictions AS
SELECT DISTINCT ON (match_id)
  match_id,
  id AS prediction_id,
  primary_result,
  primary_ft,
  primary_ht,
  hedge_result,
  hedge_ft,
  hedge_ht,
  direction_judgment,
  version_tag,
  is_lock,
  alignment_status,
  alignment_forced_degrade,
  created_at
FROM predictions
ORDER BY match_id, created_at DESC;

-- ============================================================
-- View: Review Summary (for dashboard)
-- ============================================================
CREATE OR REPLACE VIEW v_review_summary AS
SELECT
  COUNT(*) AS total_reviews,
  COUNT(*) FILTER (WHERE error_type = 'none') AS correct_predictions,
  COUNT(*) FILTER (WHERE is_upset = TRUE) AS upsets,
  ROUND(
    COUNT(*) FILTER (WHERE error_type = 'none') * 100.0 /
    NULLIF(COUNT(*), 0), 2
  ) AS hit_rate_pct
FROM review_results;
