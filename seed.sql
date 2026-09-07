-- 初期監視対象のサンプル。実際の運用では自分のVPS/アプリのURLに差し替える。
-- 適用: npm run db:seed（ローカル） / npm run db:seed:remote（本番D1）

INSERT INTO targets (name, url, expected_status) VALUES
  ('example ポータル', 'https://example.com/', 200),
  ('example ブログ', 'https://blog.example.com/', 200);

-- systemd管理下の個別アプリなど、監視対象を増やす場合は
-- 都度 INSERT INTO targets (name, url) VALUES (...) で追加していく運用とする。
