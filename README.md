# cf-vps-monitor

AI開発配下・automation-labのVPSアプリ群を20分ごとに外形監視し、状態が変わったとき（正常→異常／異常→正常）だけDiscordへ通知するダッシュボード。

**目的はFindyのスキル偏差値対策ではなく、受託開発で使えるモダン技術スタック（Cloudflare Workers/D1/KV/Cron Triggers）の実績づくり。**
Docker/AWS/CI-CD/Rails/Goに続く技術スタック速習カリキュラムの一環。

## 構成（すべてCloudflareの無料枠内）

| サービス | 役割 |
|---|---|
| Workers | 定期監視の実行（scheduled）とダッシュボード表示（fetch） |
| D1 | 監視対象一覧（`targets`）とチェック履歴（`checks`）の正本 |
| KV | 最新ステータスのスナップショット（ダッシュボード表示を高速化するキャッシュ。正本はD1）。**キーは `status:all` の1つだけ** |
| Cron Triggers | 20分ごとに `scheduled()` を起動 |

## セットアップ

```bash
npm install

# 型定義を生成（wrangler.jsonc変更のたびに再実行する。worker-configuration.d.tsは.gitignore済み）
npm run cf-typegen

# Cloudflareアカウントへログイン（初回のみ、ブラウザが開く）
npx wrangler login

# D1データベースとKV Namespaceを作成
npx wrangler d1 create cf-vps-monitor
npx wrangler kv namespace create STATUS_KV

# wrangler.jsonc（公開テンプレート、REPLACE_WITH_*のプレースホルダー入り）を複製して
# 実IDを書き込んだ wrangler.local.jsonc を作る。このファイルは.gitignore済みでコミットされない。
cp wrangler.jsonc wrangler.local.jsonc
# wrangler.local.jsonc の REPLACE_WITH_D1_DATABASE_ID / REPLACE_WITH_KV_NAMESPACE_ID を実IDに置き換える

# スキーマ適用と初期監視対象の投入（ローカル→本番の順で）
npm run db:init
npm run db:seed
npm run db:init:remote
npm run db:seed:remote

# Discord Webhookをシークレットとして登録（本番用configを明示）
npx wrangler secret put DISCORD_WEBHOOK_URL -c wrangler.local.jsonc
```

**なぜ設定ファイルを2つに分けているか:** `wrangler.jsonc` はGit管理・公開する側で、D1/KVのIDはプレースホルダーのまま。ローカル開発・テスト（`npm run dev` / `npm test`）はプレースホルダーのままでも動く（miniflareが値をローカルの識別子として使うだけのため）。本番デプロイ・本番D1操作だけ `wrangler.local.jsonc`（gitignore済み、実ID入り）を明示的に指定する。

## 開発・デプロイ

```bash
npm run dev      # ローカルで起動（http://localhost:8787）
npm test         # vitest（@cloudflare/vitest-pool-workers、ローカルD1/KVで実行）
npm run deploy   # 本番へデプロイ
```

## 監視対象の追加

`seed.sql` に倣って `targets` テーブルへ `INSERT` する。無効化したい場合は `enabled = 0` に更新する（削除すると履歴の外部キーが浮くため、無効化を基本とする）。

```bash
npx wrangler d1 execute cf-vps-monitor -c wrangler.local.jsonc --remote --command "INSERT INTO targets (name, url) VALUES ('アプリ名', 'https://example.com/path')"
```

## エンドポイント

- `GET /` — ダッシュボード（HTML）
- `GET /api/status` — 全対象の最新ステータス（JSON、KVから読む）
- `GET /api/history?target_id=<id>` — 指定対象の直近100件の履歴（JSON、D1から読む）

## 設計メモ

- 通知は状態が**変化したときだけ**送る（毎回全件通知すると埋もれるため）
- 履歴（`checks`）は30日より前の行を `scheduled()` 実行のたびに間引く（際限のない肥大化を防ぐ）
- **KVへ書くキーは `status:all` の1つだけ。** 対象ごとに `status:<id>` を持つと書き込みが「対象数+1」回/実行になり、無料枠（書き込み1,000回/日）を使い切る。前回の判定値も `status:all` から引く
- D1が正本、KVはダッシュボード表示用のキャッシュという役割分担（D1書き込みに失敗してもKVだけ古くなる形にはしていない。同じ`runChecks()`内で両方更新する）
