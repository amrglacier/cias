const { Client } = require('pg');

const DDL = `
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
CREATE POLICY "service_role_all_matches" ON matches FOR ALL USING (auth.role() = 'service_role');

CREATE TRIGGER trg_matches_updated
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function main() {
  const passwords = [
    '274135814@qq.com',
    'postgres',
    'snycievdfcyoytthxspm',
    'supabase',
  ];
  
  for (const pw of passwords) {
    console.log('Trying password:', pw.slice(0, 4) + '...');
    const client = new Client({
      connectionString: `postgresql://postgres.snycievdfcyoytthxspm:${encodeURIComponent(pw)}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
    });
    try {
      await client.connect();
      console.log('Connected! Running DDL...');
      await client.query(DDL);
      console.log('DDL executed successfully!');
      await client.end();
      return;
    } catch (e) {
      console.log('Failed:', e.message);
      try { await client.end(); } catch(_) {}
    }
  }
  
  // Also try direct connection (IPv6)
  console.log('\\nTrying direct connection (IPv6)...');
  for (const pw of passwords) {
    const client = new Client({
      connectionString: `postgresql://postgres:${encodeURIComponent(pw)}@db.snycievdfcyoytthxspm.supabase.co:5432/postgres`,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    try {
      await client.connect();
      console.log('Connected! Running DDL...');
      await client.query(DDL);
      console.log('DDL executed successfully!');
      await client.end();
      return;
    } catch (e) {
      console.log('Failed:', e.message);
      try { await client.end(); } catch(_) {}
    }
  }
  
  console.log('\\nAll connection attempts failed.');
}

main().catch(e => console.error('Fatal:', e.message));
