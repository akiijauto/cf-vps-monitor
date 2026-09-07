-- cf-vps-monitor の正本スキーマ。監視対象と、その稼働チェック履歴を持つ。
-- 適用: npm run db:init（ローカル） / npm run db:init:remote（本番D1）

CREATE TABLE IF NOT EXISTS targets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  expected_status INTEGER NOT NULL DEFAULT 200,
  timeout_ms     INTEGER NOT NULL DEFAULT 10000,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id    INTEGER NOT NULL REFERENCES targets(id),
  checked_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ok           INTEGER NOT NULL,
  status_code  INTEGER,
  latency_ms   INTEGER,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_target_time ON checks (target_id, checked_at DESC);

-- 古い履歴は肥大化を避けるため、scheduled() 実行のたびに30日より前の行を間引く（src/index.ts参照）。
