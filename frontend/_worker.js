// CIAS Frontend - Pages Worker (Proxy)
// Routes /api/* requests to Supabase REST API directly
// This bypasses the GFW-blocked workers.dev domain

const SB_URL = "https://snycievdfcyoytthxspm.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNueWNpZXZkZmN5b3l0dGh4c3BtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDI4MDEyOCwiZXhwIjoyMDk5ODU2MTI4fQ.NJGxkf_wb_VlSUDJ-YwCzXZ_98BfzzGa0goONcCLDYM";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function supabaseGet(table, query, select = "*") {
  const url = new URL(`${SB_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const resp = await fetch(url.toString(), {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
    },
  });
  return resp.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // API Routes
    if (path === "/api/health") {
      try {
        const data = await supabaseGet("match_facts", {}, "match_id");
        return jsonResponse({
          status: "healthy",
          database: Array.isArray(data) ? "ok" : "error",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        return jsonResponse({ status: "error", database: "error", message: e.message });
      }
    }

    if (path === "/api/predictions") {
      const matchId = url.searchParams.get("matchId");
      if (!matchId) {
        return jsonResponse({ error: "matchId required" }, 400);
      }
      const data = await supabaseGet(
        "predictions",
        { match_id: `eq.${matchId}`, order: "created_at.desc", limit: "10" },
        "id,match_id,primary_result,primary_ft,primary_ht,hedge_result,hedge_ft,hedge_ht,direction_judgment,version_tag,is_lock,alignment_status,alignment_forced_degrade,key_factors,delta_explanation,created_at"
      );
      if (!data || data.length === 0) {
        return jsonResponse({ prediction: null });
      }
      // Return latest non-archived, or just latest
      const latest = data.find((p) => !p.is_archived) || data[0];
      return jsonResponse({ prediction: latest });
    }

    if (path === "/api/prediction") {
      const matchId = url.searchParams.get("matchId");
      if (!matchId) {
        return jsonResponse({ error: "matchId required" }, 400);
      }
      const data = await supabaseGet(
        "predictions",
        { match_id: `eq.${matchId}`, is_lock: "eq.true", order: "created_at.desc", limit: "1" },
        "id,match_id,primary_result,primary_ft,primary_ht,hedge_result,hedge_ft,hedge_ht,direction_judgment,version_tag,is_lock,alignment_status,alignment_forced_degrade,key_factors,delta_explanation,created_at"
      );
      if (!data || data.length === 0) {
        // Fallback: get latest non-archived
        const fallback = await supabaseGet(
          "predictions",
          { match_id: `eq.${matchId}`, order: "created_at.desc", limit: "1" },
          "id,match_id,primary_result,primary_ft,primary_ht,hedge_result,hedge_ft,hedge_ht,direction_judgment,version_tag,is_lock,alignment_status,alignment_forced_degrade,key_factors,delta_explanation,created_at"
        );
        if (!fallback || fallback.length === 0) {
          return jsonResponse({ error: "No locked prediction found" }, 404);
        }
        return jsonResponse({ prediction: fallback[0] });
      }
      return jsonResponse({ prediction: data[0] });
    }

    if (path === "/api/all-predictions") {
      const data = await supabaseGet(
        "predictions",
        { is_archived: "eq.false", order: "created_at.desc", limit: "50" },
        "id,match_id,primary_result,primary_ft,primary_ht,hedge_result,hedge_ft,hedge_ht,direction_judgment,version_tag,is_lock,alignment_status,alignment_forced_degrade,key_factors,delta_explanation,created_at"
      );
      return jsonResponse({ predictions: data || [] });
    }

    if (path === "/api/match-facts") {
      const matchId = url.searchParams.get("matchId");
      if (!matchId) {
        return jsonResponse({ error: "matchId required" }, 400);
      }
      const data = await supabaseGet(
        "match_facts",
        { match_id: `eq.${matchId}` },
        "*"
      );
      return jsonResponse({ facts: data[0] || null });
    }

    if (path === "/api/odds-snapshots") {
      const matchId = url.searchParams.get("matchId");
      if (!matchId) {
        return jsonResponse({ error: "matchId required" }, 400);
      }
      const data = await supabaseGet(
        "odds_snapshots",
        { match_id: `eq.${matchId}`, order: "captured_at.desc", limit: "10" },
        "id,match_id,captured_at,home_odds,draw_odds,away_odds,source,signal_type,is_sharp_move,is_steam_move"
      );
      return jsonResponse({ snapshots: data || [] });
    }

    if (path === "/api/reviews") {
      const limit = url.searchParams.get("limit") || "20";
      const matchId = url.searchParams.get("matchId");
      const query = { order: "created_at.desc", limit };
      if (matchId) {
        query.match_id = `eq.${matchId}`;
      }
      const data = await supabaseGet(
        "review_results",
        query,
        "id,match_id,prediction_id,actual_result,actual_ft,actual_ht,attribution_code,attribution_party,attribution_detail,error_type,is_upset,created_at"
      );
      return jsonResponse({ reviews: data || [] });
    }

    if (path === "/api/config") {
      const key = url.searchParams.get("key") || "factor_weights";
      const data = await supabaseGet(
        "system_config",
        { key: `eq.${key}` },
        "key,value"
      );
      return jsonResponse({ key, value: data[0]?.value || {} });
    }

    if (path === "/api/all-match-facts") {
      const data = await supabaseGet(
        "match_facts",
        { order: "match_id.asc" },
        "match_id,home_xg_adj,away_xg_adj,home_conc_adj,away_conc_adj,injury_impact_home,injury_impact_away,weather_decay,referee_strictness,motivation_home,motivation_away,odds_zone,bias_correction,data_confidence,status,created_at"
      );
      return jsonResponse({ matches: data || [] });
    }

    // Default: not found
    return jsonResponse({ error: "Not Found", path }, 404);
  },
};
