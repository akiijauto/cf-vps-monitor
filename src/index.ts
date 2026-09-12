export interface Env {
  DB: D1Database;
  STATUS_KV: KVNamespace;
  DISCORD_WEBHOOK_URL?: string;
}

interface Target {
  id: number;
  name: string;
  url: string;
  expected_status: number;
  timeout_ms: number;
  enabled: number;
}

interface CheckResult {
  target: Target;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

interface LatestStatus {
  target_id: number;
  name: string;
  url: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
}

const HISTORY_RETENTION_DAYS = 30;

async function checkTarget(target: Target): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeout_ms);
  const startedAt = Date.now();
  try {
    const res = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'cf-vps-monitor/1.0' },
    });
    const latency_ms = Date.now() - startedAt;
    return {
      target,
      ok: res.status === target.expected_status,
      status_code: res.status,
      latency_ms,
      error: res.status === target.expected_status ? null : `expected ${target.expected_status}, got ${res.status}`,
    };
  } catch (e) {
    return {
      target,
      ok: false,
      status_code: null,
      latency_ms: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 直前の判定と比べて変化した対象だけをDiscordへ通知する（Cronのたびに全件通知すると埋もれる）。
async function notifyIfChanged(env: Env, result: CheckResult, previousOk: boolean | null): Promise<void> {
  if (previousOk === null || previousOk === result.ok) return;
  const webhook = env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  const content = result.ok
    ? `✅ **復旧**: ${result.target.name}\n${result.target.url}`
    : `🔴 **ダウン検知**: ${result.target.name}\n${result.target.url}\n理由: ${result.error ?? '不明'}`;

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.status >= 400) {
      console.error(`Discord通知に失敗しました: HTTP ${res.status}`);
    }
  } catch (e) {
    // Webhook URLをそのままログへ出さない（feedback_discord_notification.mdの教訓）。
    console.error('Discord通知に失敗しました:', e instanceof Error ? e.message : String(e));
  }
}

async function runChecks(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, url, expected_status, timeout_ms, enabled FROM targets WHERE enabled = 1'
  ).all<Target>();

  const now = new Date().toISOString();
  const latestList: LatestStatus[] = [];

  // 前回の判定は status:all からまとめて読む。対象ごとに status:<id> を持つと
  // KV書き込みが「対象数+1」回/実行になり、無料枠（書き込み1,000回/日）を使い切る。
  // 2026-09-12、対象3件・5分間隔で1日1,152回に達し上限90%の警告が届いた。
  const previousRaw = await env.STATUS_KV.get('status:all');
  const previousOkById = new Map<number, boolean>();
  if (previousRaw) {
    try {
      for (const prev of JSON.parse(previousRaw) as LatestStatus[]) {
        previousOkById.set(prev.target_id, prev.ok);
      }
    } catch (e) {
      // 壊れたJSON1件で全対象の監視を止めない。前回値なし（＝初回扱い）で続行する。
      console.error(
        'status:all を読めませんでした。前回値なしとして続行します:',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  for (const target of results) {
    const result = await checkTarget(target);

    const previousOk = previousOkById.has(target.id) ? previousOkById.get(target.id)! : null;

    await env.DB.prepare(
      'INSERT INTO checks (target_id, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(target.id, result.ok ? 1 : 0, result.status_code, result.latency_ms, result.error)
      .run();

    const latest: LatestStatus = {
      target_id: target.id,
      name: target.name,
      url: target.url,
      ok: result.ok,
      status_code: result.status_code,
      latency_ms: result.latency_ms,
      error: result.error,
      checked_at: now,
    };
    latestList.push(latest);

    await notifyIfChanged(env, result, previousOk);
  }

  // KVへの書き込みはここ1回だけ。対象を増やしても書き込み回数は増えない。
  await env.STATUS_KV.put('status:all', JSON.stringify(latestList));

  // 履歴の間引き。checksテーブルが際限なく増えるのを防ぐ。
  const cutoff = new Date(Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM checks WHERE checked_at < ?').bind(cutoff).run();
}

function renderDashboard(latestList: LatestStatus[]): string {
  const rows = latestList
    .map((s) => {
      const badge = s.ok ? '🟢 正常' : '🔴 異常';
      const detail = s.ok ? `${s.latency_ms ?? '-'}ms` : (s.error ?? '不明なエラー');
      return `<tr><td>${badge}</td><td>${escapeHtml(s.name)}</td><td><a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a></td><td>${escapeHtml(detail)}</td><td>${escapeHtml(s.checked_at)}</td></tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>VPS稼働監視ダッシュボード</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; background: #0b0e14; color: #e6e6e6; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #333; text-align: left; }
th { color: #9aa; }
a { color: #6cf; }
h1 { font-size: 1.2rem; }
</style>
</head>
<body>
<h1>VPS稼働監視ダッシュボード</h1>
<p>20分ごとにCronで外形監視。異常への遷移・復旧のみDiscordへ通知。</p>
<table>
<thead><tr><th>状態</th><th>名前</th><th>URL</th><th>詳細</th><th>最終確認</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="5">監視対象が未登録です（seed.sqlを適用してください）</td></tr>'}
</tbody>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/status') {
      const raw = await env.STATUS_KV.get('status:all');
      return new Response(raw ?? '[]', { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    if (url.pathname === '/api/history') {
      const targetId = url.searchParams.get('target_id');
      if (!targetId) {
        return new Response(JSON.stringify({ error: 'target_id is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      const { results } = await env.DB.prepare(
        'SELECT checked_at, ok, status_code, latency_ms, error FROM checks WHERE target_id = ? ORDER BY checked_at DESC LIMIT 100'
      )
        .bind(targetId)
        .all();
      return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }

    const raw = await env.STATUS_KV.get('status:all');
    const latestList: LatestStatus[] = raw ? JSON.parse(raw) : [];
    return new Response(renderDashboard(latestList), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runChecks(env));
  },
};
