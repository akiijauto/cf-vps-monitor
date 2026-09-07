import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

describe('cf-vps-monitor', () => {
  beforeEach(async () => {
    // D1のexec()は文をNEWLINEで区切るため、CREATE TABLE文は1行に詰める。
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS targets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, expected_status INTEGER NOT NULL DEFAULT 200, timeout_ms INTEGER NOT NULL DEFAULT 10000, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id INTEGER NOT NULL, checked_at TEXT NOT NULL DEFAULT (datetime('now')), ok INTEGER NOT NULL, status_code INTEGER, latency_ms INTEGER, error TEXT)"
    );
  });

  it('監視対象が未登録なら、ダッシュボードはその旨を表示する', async () => {
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('監視対象が未登録です');
  });

  it('/api/status は空配列をJSONで返す（未実行時）', async () => {
    const res = await SELF.fetch('https://example.com/api/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('/api/history は target_id 必須', async () => {
    const res = await SELF.fetch('https://example.com/api/history');
    expect(res.status).toBe(400);
  });
});
