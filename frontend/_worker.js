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

async function supabasePost(table, body) {
  const resp = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify(body),
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

    if (path === "/api/config/betting-window") {
      if (request.method === "GET") {
        const data = await supabaseGet(
          "system_config",
          { key: "eq.betting_window_config" },
          "key,value"
        );
        return jsonResponse({ config: data[0]?.value || {} });
      }
      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { start_hours_before_kickoff, end_minutes_before_kickoff, league_ids, season } = body;
          if (typeof start_hours_before_kickoff !== "number" || start_hours_before_kickoff < 1 || start_hours_before_kickoff > 72) {
            return jsonResponse({ error: "start_hours_before_kickoff must be a number between 1 and 72" }, 400);
          }
          if (typeof end_minutes_before_kickoff !== "number" || end_minutes_before_kickoff < 0 || end_minutes_before_kickoff > 120) {
            return jsonResponse({ error: "end_minutes_before_kickoff must be a number between 0 and 120" }, 400);
          }
          if (end_minutes_before_kickoff >= start_hours_before_kickoff * 60) {
            return jsonResponse({ error: "end_minutes_before_kickoff must be less than start_hours_before_kickoff * 60" }, 400);
          }
          const configValue = {
            start_hours_before_kickoff,
            end_minutes_before_kickoff,
            league_ids: Array.isArray(league_ids) ? league_ids : [39, 140, 135, 78, 61],
            season: typeof season === "string" ? season : "2025",
          };
          const result = await supabasePost("system_config", {
            key: "betting_window_config",
            value: configValue,
          });
          return jsonResponse({ success: true, config: configValue, result });
        } catch (e) {
          return jsonResponse({ error: e.message }, 500);
        }
      }
    }

    if (path === "/api/upcoming-matches") {
      const data = await supabaseGet(
        "matches",
        { status: "eq.scheduled", order: "kickoff_time.asc", limit: "20" },
        "match_id,home_team,away_team,league,kickoff_time,status,round,venue"
      );
      return jsonResponse({ matches: data || [] });
    }

    if (path === "/api/all-match-facts") {
      const data = await supabaseGet(
        "match_facts",
        { order: "match_id.asc" },
        "match_id,home_xg_adj,away_xg_adj,home_conc_adj,away_conc_adj,injury_impact_home,injury_impact_away,weather_decay,referee_strictness,motivation_home,motivation_away,odds_zone,bias_correction,data_confidence,status,created_at"
      );
      return jsonResponse({ matches: data || [] });
    }

    // Serve index.html for root path and non-API paths
    if (path === '/' || path === '/index.html') {
      const indexContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIAS - 协同研判自动化系统</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1419; color: #e6e6e6; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid #2a2a2a; margin-bottom: 24px; }
    .header h1 { font-size: 24px; color: #4fc3f7; }
    .header .version { font-size: 12px; color: #666; }
    .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
    .tab { padding: 8px 16px; border: 1px solid #333; border-radius: 6px; cursor: pointer; background: #1a1a2e; color: #888; font-size: 14px; transition: all 0.2s; }
    .tab.active { background: #4fc3f7; color: #0f1419; border-color: #4fc3f7; }
    .card { background: #1a1a2e; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .card-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #4fc3f7; }
    .prediction-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 16px; }
    .pred-card { background: #16213e; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; position: relative; }
    .pred-card.locked { border-color: #4caf50; }
    .pred-card.forced { border-color: #ff9800; }
    .pred-header { display: flex; justify-content: space-between; margin-bottom: 12px; }
    .pred-match { font-size: 14px; font-weight: 600; }
    .pred-version { font-size: 11px; padding: 2px 8px; border-radius: 4px; }
    .version-INITIAL { background: #1b5e20; color: #a5d6a7; }
    .version-FINAL { background: #0d47a1; color: #82b1ff; }
    .pred-direction { font-size: 15px; padding: 8px 12px; background: #0f1419; border-radius: 4px; margin: 8px 0; border-left: 3px solid #4fc3f7; }
    .pred-scores { display: flex; gap: 12px; margin: 8px 0; }
    .score-box { flex: 1; background: #0f1419; border-radius: 4px; padding: 8px; }
    .score-label { font-size: 11px; color: #666; }
    .score-value { font-size: 18px; font-weight: 700; color: #e6e6e6; }
    .pred-footer { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #666; margin-top: 8px; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 10px; }
    .badge-aligned { background: #1b5e20; color: #a5d6a7; }
    .badge-forced { background: #bf360c; color: #ffab91; }
    .badge-pending { background: #37474f; color: #90a4ae; }
    .review-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .stat-box { background: #16213e; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-value { font-size: 32px; font-weight: 700; color: #4fc3f7; }
    .stat-label { font-size: 12px; color: #666; margin-top: 4px; }
    .factors-list { list-style: none; padding: 0; }
    .factor-item { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1a1a2e; font-size: 13px; }
    .factor-id { color: #666; }
    .factor-value { color: #4fc3f7; font-family: monospace; }
    .empty { text-align: center; padding: 48px; color: #666; }
    .loading { text-align: center; padding: 48px; color: #4fc3f7; }
    input, select, button { background: #0f1419; border: 1px solid #333; color: #e6e6e6; padding: 8px 12px; border-radius: 4px; font-size: 14px; }
    button { cursor: pointer; background: #4fc3f7; color: #0f1419; border: none; font-weight: 600; }
    button:hover { background: #29b6f6; }
    .input-row { display: flex; gap: 8px; margin-bottom: 16px; }
    .match-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .match-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #16213e; border: 1px solid #2a2a2a; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
    .match-item:hover { border-color: #4fc3f7; }
    .match-item.active { border-color: #4fc3f7; background: #1a237e; }
    .match-id { font-weight: 600; font-size: 14px; }
    .match-status { font-size: 11px; color: #666; }
    .odds-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    .odds-table th, .odds-table td { padding: 6px 10px; text-align: center; border-bottom: 1px solid #1a1a2e; font-size: 12px; }
    .odds-table th { color: #666; }
    .sharp { color: #ff9800; font-weight: 600; }
    .steam { color: #f44336; font-weight: 600; }
    .delta-explain { font-size: 12px; color: #ffcc80; padding: 6px 8px; background: #0f1419; border-radius: 4px; margin-top: 8px; border-left: 2px solid #ff9800; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>CIAS - 协同研判自动化系统</h1>
        <div class="version">V1.4.2-SRS-FULL-PROD</div>
      </div>
      <div id="health-status">Loading...</div>
    </div>
    <div class="tabs">
      <div class="tab active" data-tab="predictions">预测结果</div>
      <div class="tab" data-tab="review">复盘看板</div>
      <div class="tab" data-tab="matches">基本面数据</div>
      <div class="tab" data-tab="fixtures">赛程</div>
      <div class="tab" data-tab="config">系统配置</div>
    </div>
    <div id="tab-predictions" class="tab-content">
      <div class="input-row">
        <input type="text" id="match-id-input" placeholder="输入 Match ID (如 EPL-2026-M001)" style="flex:1">
        <button onclick="loadPrediction()">查询预测</button>
        <button onclick="loadAllPredictions()" style="background:#1a1a2e;color:#4fc3f7;border:1px solid #4fc3f7">加载全部</button>
      </div>
      <div id="predictions-container" class="prediction-grid"><div class="empty">点击「加载全部」查看所有预测，或输入 Match ID 查询</div></div>
    </div>
    <div id="tab-review" class="tab-content" style="display:none">
      <div class="review-grid">
        <div class="stat-box"><div class="stat-value" id="stat-total">-</div><div class="stat-label">总复盘数</div></div>
        <div class="stat-box"><div class="stat-value" id="stat-hitrate">-</div><div class="stat-label">命中率 (%)</div></div>
        <div class="stat-box"><div class="stat-value" id="stat-upsets">-</div><div class="stat-label">冷门数</div></div>
      </div>
      <div id="reviews-container"><div class="loading">加载复盘数据...</div></div>
    </div>
    <div id="tab-matches" class="tab-content" style="display:none">
      <div id="matches-container"><div class="loading">加载基本面数据...</div></div>
    </div>
    <div id="tab-fixtures" class="tab-content" style="display:none">
      <div id="fixtures-container"><div class="loading">加载赛程数据...</div></div>
    </div>
    <div id="tab-config" class="tab-content" style="display:none">
      <div class="card">
        <div class="card-title">购彩时间配置</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:end;margin-bottom:16px">
          <div><label style="font-size:12px;color:#666;display:block;margin-bottom:4px">开始购彩 (赛前N小时)</label><input type="number" id="bw-start" min="1" max="72" value="2" style="width:80px"></div>
          <div><label style="font-size:12px;color:#666;display:block;margin-bottom:4px">截止购彩 (赛前N分钟)</label><input type="number" id="bw-end" min="0" max="120" value="15" style="width:80px"></div>
          <div><label style="font-size:12px;color:#666;display:block;margin-bottom:4px">赛季</label><input type="text" id="bw-season" value="2025" style="width:80px"></div>
          <button onclick="saveBettingWindowConfig()">保存</button>
        </div>
        <div id="bw-status" style="font-size:12px;color:#666"></div>
      </div>
      <div class="card">
        <div class="card-title">因子权重配置</div>
        <div id="config-container">加载中...</div>
      </div>
      <div class="card">
        <div class="card-title">复盘配置</div>
        <div id="review-config-container">加载中...</div>
      </div>
    </div>
  </div>
  <script>
    const API_BASE = '';
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).style.display = 'block';
        if (tab.dataset.tab === 'matches' && !document.getElementById('matches-container').dataset.loaded) { loadAllMatchFacts(); }
        if (tab.dataset.tab === 'fixtures' && !document.getElementById('fixtures-container').dataset.loaded) { loadUpcomingMatches(); }
        if (tab.dataset.tab === 'config' && !document.getElementById('bw-status').dataset.loaded) { loadBettingWindowConfig(); }
      });
    });
    async function checkHealth() {
      try { const resp = await fetch(API_BASE + '/api/health'); const data = await resp.json(); document.getElementById('health-status').innerHTML = '<span style="color:' + (data.status === 'healthy' ? '#4caf50' : '#f44336') + '">● ' + (data.status === 'healthy' ? 'Online' : 'Error') + '</span>'; }
      catch (e) { document.getElementById('health-status').innerHTML = '<span style="color:#f44336">● Offline</span>'; }
    }
    async function loadPrediction() {
      const matchId = document.getElementById('match-id-input').value.trim();
      if (!matchId) { alert('请输入 Match ID'); return; }
      document.getElementById('predictions-container').innerHTML = '<div class="loading">查询中...</div>';
      try {
        const resp = await fetch(API_BASE + '/api/prediction?matchId=' + matchId);
        if (!resp.ok) { document.getElementById('predictions-container').innerHTML = '<div class="empty">未找到 Match ID: ' + matchId + ' 的锁定预测</div>'; return; }
        const data = await resp.json();
        if (!data.prediction) { document.getElementById('predictions-container').innerHTML = '<div class="empty">未找到 Match ID: ' + matchId + ' 的预测结果</div>'; return; }
        renderPredictions([data.prediction]);
        try { const oddsResp = await fetch(API_BASE + '/api/odds-snapshots?matchId=' + matchId); const oddsData = await oddsResp.json(); if (oddsData.snapshots && oddsData.snapshots.length > 0) { renderOdds(oddsData.snapshots); } } catch(e) {}
      } catch (e) { document.getElementById('predictions-container').innerHTML = '<div class="empty">查询失败: ' + e.message + '</div>'; }
    }
    async function loadAllPredictions() {
      document.getElementById('predictions-container').innerHTML = '<div class="loading">加载中...</div>';
      try {
        const resp = await fetch(API_BASE + '/api/all-predictions');
        const data = await resp.json();
        if (!data.predictions || data.predictions.length === 0) { document.getElementById('predictions-container').innerHTML = '<div class="empty">暂无预测数据</div>'; return; }
        renderPredictions(data.predictions);
      } catch (e) { document.getElementById('predictions-container').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
    }
    function renderPredictions(predictions) {
      if (!predictions || predictions.length === 0) { document.getElementById('predictions-container').innerHTML = '<div class="empty">无预测数据</div>'; return; }
      const html = predictions.map(p => {
        if (!p) return '';
        const lockedClass = p.is_lock ? 'locked' : '';
        const forcedClass = p.alignment_forced_degrade ? 'forced' : '';
        const versionClass = 'version-' + p.version_tag;
        const alignBadge = p.alignment_status === 'aligned' ? '<span class="badge badge-aligned">ALIGNED</span>' : p.alignment_forced_degrade ? '<span class="badge badge-forced">FORCED DEGRADE</span>' : '<span class="badge badge-pending">PENDING</span>';
        const primaryText = p.primary_result === 'home_win' ? '主胜' : p.primary_result === 'draw' ? '平局' : '客胜';
        const hedgeText = p.hedge_result ? (p.hedge_result === 'home_win' ? '主胜' : p.hedge_result === 'draw' ? '平局' : '客胜') : '无';
        const factorsHtml = Object.entries(p.key_factors || {}).map(([id, f]) => '<div class="factor-item"><span class="factor-id">' + id + '</span><span class="factor-value">' + (f.value !== null && f.value !== undefined ? f.value.toFixed(3) : 'N/A') + ' (w:' + (f.weight !== null && f.weight !== undefined ? f.weight.toFixed(2) : 'N/A') + ')</span></div>').join('');
        const deltaHtml = p.delta_explanation ? '<div class="delta-explain">' + p.delta_explanation + '</div>' : '';
        return '<div class="pred-card ' + lockedClass + ' ' + forcedClass + '"><div class="pred-header"><div class="pred-match">' + p.match_id + '</div><div class="pred-version ' + versionClass + '">' + p.version_tag + '</div></div><div class="pred-direction">' + (p.direction_judgment || 'N/A') + '</div><div class="pred-scores"><div class="score-box"><div class="score-label">主推 (' + primaryText + ')</div><div class="score-value">' + (p.primary_ft || 'N/A') + ' <span style="font-size:12px;color:#666">(' + (p.primary_ht || '-') + ')</span></div></div><div class="score-box"><div class="score-label">备选 (' + hedgeText + ')</div><div class="score-value">' + (p.hedge_ft || 'N/A') + ' <span style="font-size:12px;color:#666">(' + (p.hedge_ht || '-') + ')</span></div></div></div><div class="pred-footer">' + alignBadge + '<span>' + (p.is_lock ? '🔒 LOCKED' : '') + '</span></div>' + deltaHtml + (factorsHtml ? '<details><summary style="cursor:pointer;font-size:12px;color:#666;margin-top:8px">Key Factors (' + Object.keys(p.key_factors || {}).length + ')</summary><ul class="factors-list">' + factorsHtml + '</ul></details>' : '') + '</div>';
      }).join('');
      document.getElementById('predictions-container').innerHTML = html;
    }
    function renderOdds(snapshots) {
      const oddsHtml = '<div class="card" style="grid-column: 1 / -1; margin-top: 16px;"><div class="card-title">赔率快照 (' + snapshots.length + ')</div><table class="odds-table"><thead><tr><th>时间</th><th>主胜</th><th>平</th><th>客胜</th><th>信号</th></tr></thead><tbody>' + snapshots.map(s => '<tr><td>' + new Date(s.captured_at).toLocaleString() + '</td><td>' + s.home_odds + '</td><td>' + s.draw_odds + '</td><td>' + s.away_odds + '</td><td>' + (s.is_steam_move ? '<span class="steam">STEAM</span>' : s.is_sharp_move ? '<span class="sharp">SHARP</span>' : '-') + '</td></tr>').join('') + '</tbody></table></div>';
      document.getElementById('predictions-container').insertAdjacentHTML('beforeend', oddsHtml);
    }
    async function loadReviews() {
      try {
        const resp = await fetch(API_BASE + '/api/reviews?limit=20');
        const data = await resp.json();
        const reviews = data.reviews || [];
        document.getElementById('stat-total').textContent = reviews.length;
        document.getElementById('stat-hitrate').textContent = reviews.length > 0 ? ((reviews.filter(r => r.error_type === 'none').length / reviews.length) * 100).toFixed(1) : '0.0';
        document.getElementById('stat-upsets').textContent = reviews.filter(r => r.is_upset).length;
        if (reviews.length === 0) { document.getElementById('reviews-container').innerHTML = '<div class="empty">无复盘数据</div>'; return; }
        document.getElementById('reviews-container').innerHTML = reviews.map(r => {
          const codeClass = r.attribution_party === 'data' ? 'version-PERIODIC' : 'version-FINAL';
          const actualText = r.actual_result === 'home_win' ? '主胜' : r.actual_result === 'draw' ? '平局' : '客胜';
          return '<div class="card"><div style="display:flex;justify-content:space-between"><div><strong>' + r.match_id + '</strong> - <span class="badge ' + codeClass + '">' + r.attribution_code + '</span></div><div style="font-size:11px;color:#666">' + (r.created_at ? new Date(r.created_at).toLocaleString() : '') + '</div></div><div style="margin-top:8px;font-size:13px">' + r.attribution_detail + '</div><div style="margin-top:6px;font-size:12px">实际赛果: <strong>' + actualText + ' ' + r.actual_ft + '</strong> | 归因: <strong>' + r.attribution_party + '</strong> | 错误类型: ' + r.error_type + ' | 冷门: ' + (r.is_upset ? '是' : '否') + '</div></div>';
        }).join('');
      } catch (e) { document.getElementById('reviews-container').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
    }
    async function loadAllMatchFacts() {
      try {
        const resp = await fetch(API_BASE + '/api/all-match-facts');
        const data = await resp.json();
        const matches = data.matches || [];
        if (matches.length === 0) { document.getElementById('matches-container').innerHTML = '<div class="empty">无基本面数据</div>'; return; }
        document.getElementById('matches-container').innerHTML = matches.map(m => '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><div class="match-id">' + m.match_id + '</div><div class="match-status">' + m.status + '</div></div><table class="odds-table"><thead><tr><th>指标</th><th>主队</th><th>客队</th></tr></thead><tbody><tr><td>xG (除权)</td><td>' + (m.home_xg_adj ? m.home_xg_adj.toFixed(2) : 'N/A') + '</td><td>' + (m.away_xg_adj ? m.away_xg_adj.toFixed(2) : 'N/A') + '</td></tr><tr><td>失球率 (除权)</td><td>' + (m.home_conc_adj ? m.home_conc_adj.toFixed(2) : 'N/A') + '</td><td>' + (m.away_conc_adj ? m.away_conc_adj.toFixed(2) : 'N/A') + '</td></tr><tr><td>伤停影响</td><td>' + (m.injury_impact_home ? m.injury_impact_home.toFixed(2) : 'N/A') + '</td><td>' + (m.injury_impact_away ? m.injury_impact_away.toFixed(2) : 'N/A') + '</td></tr><tr><td>战意系数</td><td>' + (m.motivation_home ? m.motivation_home.toFixed(2) : 'N/A') + '</td><td>' + (m.motivation_away ? m.motivation_away.toFixed(2) : 'N/A') + '</td></tr><tr><td>阵型克制</td><td>' + (m.formation_ctr_home ? m.formation_ctr_home.toFixed(3) : 'N/A') + '</td><td>' + (m.formation_ctr_away ? m.formation_ctr_away.toFixed(3) : 'N/A') + '</td></tr></tbody></table><div style="margin-top:8px;font-size:12px;color:#666">天气衰减: ' + (m.weather_decay ? m.weather_decay.toFixed(2) : 'N/A') + ' | 裁判严厉度: ' + m.referee_strictness + ' | 赔率区间: ' + (m.odds_zone || 'N/A') + ' | 偏态修正: ' + (m.bias_correction ? m.bias_correction.toFixed(3) : 'N/A') + ' | 数据置信度: ' + (m.data_confidence ? (m.data_confidence * 100).toFixed(0) : 'N/A') + '% | 贝叶斯平滑: ' + (m.bayesian_prior_applied ? '已应用' : '未应用') + '</div></div>').join('');
        document.getElementById('matches-container').dataset.loaded = 'true';
      } catch (e) { document.getElementById('matches-container').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
    }
    async function loadConfig() {
      try {
        const resp = await fetch(API_BASE + '/api/config?key=factor_weights');
        const data = await resp.json();
        const weights = data.value || {};
        document.getElementById('config-container').innerHTML = Object.entries(weights).map(([key, value]) => '<div class="factor-item"><span class="factor-id">' + key + '</span><span class="factor-value">' + value + '</span></div>').join('') || '<div class="empty">无配置数据</div>';
      } catch (e) { document.getElementById('config-container').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
      try {
        const resp = await fetch(API_BASE + '/api/config?key=review_config');
        const data = await resp.json();
        const config = data.value || {};
        document.getElementById('review-config-container').innerHTML = Object.entries(config).map(([key, value]) => '<div class="factor-item"><span class="factor-id">' + key + '</span><span class="factor-value">' + value + '</span></div>').join('') || '<div class="empty">无配置数据</div>';
      } catch (e) { document.getElementById('review-config-container').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
    }
    async function loadUpcomingMatches() {
      try {
        const resp = await fetch(API_BASE + '/api/upcoming-matches');
        const data = await resp.json();
        const matches = data.matches || [];
        if (matches.length === 0) { document.getElementById('fixtures-container').innerHTML = '<div class="empty">暂无赛程数据（Cron 将自动拉取）</div>'; return; }
        document.getElementById('fixtures-container').innerHTML = matches.map(m => {
          const kickoff = m.kickoff_time ? new Date(m.kickoff_time).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) : 'N/A';
          return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div><strong>' + (m.home_team || 'TBD') + '</strong> vs <strong>' + (m.away_team || 'TBD') + '</strong><span style="margin-left:8px;font-size:11px;color:#666">' + (m.league || '') + '</span></div><div style="font-size:11px;color:#666">' + kickoff + '</div></div><div style="margin-top:6px;font-size:12px;color:#888">Match ID: ' + m.match_id + ' | Round: ' + (m.round || '-') + ' | Venue: ' + (m.venue || '-') + ' | Status: ' + m.status + '</div></div>';
        }).join('');
        document.getElementById('fixtures-container').dataset.loaded = 'true';
      } catch (e) { document.getElementById('fixtures-container').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>'; }
    }
    async function loadBettingWindowConfig() {
      try {
        const resp = await fetch(API_BASE + '/api/config/betting-window');
        const data = await resp.json();
        const cfg = data.config || {};
        document.getElementById('bw-start').value = cfg.start_hours_before_kickoff ?? 2;
        document.getElementById('bw-end').value = cfg.end_minutes_before_kickoff ?? 15;
        document.getElementById('bw-season').value = cfg.season || '2025';
        document.getElementById('bw-status').textContent = '已加载配置 | 联赛IDs: ' + (cfg.league_ids || [39,140,135,78,61]).join(', ');
        document.getElementById('bw-status').dataset.loaded = 'true';
      } catch (e) { document.getElementById('bw-status').textContent = '加载失败: ' + e.message; }
    }
    async function saveBettingWindowConfig() {
      const start = parseInt(document.getElementById('bw-start').value);
      const end = parseInt(document.getElementById('bw-end').value);
      const season = document.getElementById('bw-season').value.trim();
      if (!start || start < 1 || start > 72) { alert('开始购彩时间须为 1-72 小时'); return; }
      if (isNaN(end) || end < 0 || end > 120) { alert('截止购彩时间须为 0-120 分钟'); return; }
      if (end >= start * 60) { alert('截止购彩时间须早于开始购彩时间（' + (start*60) + '分钟）'); return; }
      document.getElementById('bw-status').textContent = '保存中...';
      try {
        const resp = await fetch(API_BASE + '/api/config/betting-window', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start_hours_before_kickoff: start, end_minutes_before_kickoff: end, league_ids: [39,140,135,78,61], season: season || '2025' })
        });
        const data = await resp.json();
        if (data.success) { document.getElementById('bw-status').innerHTML = '<span style="color:#4caf50">保存成功</span> | 开始: 赛前' + start + '小时, 截止: 赛前' + end + '分钟, 赛季: ' + (season || '2025'); }
        else { document.getElementById('bw-status').innerHTML = '<span style="color:#f44336">保存失败: ' + (data.error || '未知错误') + '</span>'; }
      } catch (e) { document.getElementById('bw-status').innerHTML = '<span style="color:#f44336">保存失败: ' + e.message + '</span>'; }
    }
    checkHealth();
    loadReviews();
    loadConfig();
    setInterval(checkHealth, 60000);
  </script>
</body>
</html>`;
      return new Response(indexContent, { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=0, must-revalidate" } });
    }

    // For non-API paths, try to serve as static
    if (!path.startsWith('/api/')) {
      // Return index.html for SPA routing
      return new Response(indexContent, { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=0, must-revalidate" } });
    }
  },
};
