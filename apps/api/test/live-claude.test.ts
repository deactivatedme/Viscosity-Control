/**
 * Opt-in: runs a REAL Claude Code agent (Claude Agent SDK) through the whole stack and spends real tokens.
 *   VISCOSITY_LIVE_CLAUDE=1 pnpm exec vitest run apps/api/test/live-claude.test.ts
 * The worker must be able to authenticate to Anthropic: either export ANTHROPIC_API_KEY, or run where
 * Claude Code is already logged in for the worker's user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { startWorker } from '../../worker/src/worker';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/server';

const live = process.env.VISCOSITY_LIVE_CLAUDE === '1';
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://viscosity:viscosity@127.0.0.1:5432/postgres';
const DB_NAME = `viscosity_live_${process.pid}`;
const ORIGIN = 'http://dashboard.test';

describe.skipIf(!live)('live Claude agent', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let base = '';
  let cookie = '';
  let serverId = '';
  let root = '';
  let dataDir = '';

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { cookie, origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => null);
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    return { status: res.status, json: json as any };
  };
  const until = async <T,>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 180_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  beforeAll(async () => {
    const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
    await sql.unsafe(`create database ${DB_NAME}`);
    await sql.end();
    root = mkdtempSync(path.join(tmpdir(), 'vc-live-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'vc-live-data-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    built = await buildApp(loadConfig({ DATABASE_URL: ADMIN_DB.replace(/\/[^/]+$/, `/${DB_NAME}`), VISCOSITY_SECRET_KEY: 'live-test-key-0123456789abcdef-0123', PUBLIC_ORIGIN: ORIGIN, DATA_DIR: dataDir, LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv));
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    await call('POST', '/api/setup', { email: 'live@test.dev', password: 'a-long-enough-password' });
    const created = await call('POST', '/api/servers', { name: 'live' });
    serverId = created.json.server.id;
    const enrolled = await (await fetch(`${base}/api/worker/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: created.json.enrollment.token, protocol: 1, hostname: 'live' }) })).json() as { secret: string };
    worker = await startWorker({ controlUrl: base, serverId, secret: enrolled.secret, roots: [root], dataDir: path.join(dataDir, 'w'), allowRootShell: true });
    await until('online', async () => (await call('GET', `/api/servers/${serverId}`)).json.status === 'online', 15_000);
  });

  afterAll(async () => {
    await worker?.stop();
    await built?.app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
    await sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await sql.end();
  });

  it('asks for approval, edits a file once approved, persists history, and resumes the conversation', async () => {
    const created = await call('POST', '/api/agents', {
      serverId, provider: 'claude', cwd: root, permissionMode: 'ask',
      prompt: 'Use the Write tool to create a file named hello.txt in the current directory containing exactly the text: viscosity-ok. Do nothing else, then reply "done".',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = created.json.id;

    // The edit must wait for the operator.
    const pending = await until('approval request', async () => {
      const a = (await call('GET', `/api/agents/${id}`)).json;
      if (['failed', 'completed', 'lost'].includes(a.status)) throw new Error(`agent ended early: ${a.status} ${a.statusDetail ?? ''}`);
      return a.status === 'waiting_approval' && a.approvals.length ? a.approvals[0] : null;
    });
    expect(existsSync(path.join(root, 'hello.txt'))).toBe(false);
    expect(pending.payload.tool).toBe('Write');
    expect((await call('POST', `/api/agents/${id}/approvals/${encodeURIComponent(pending.approvalId)}`, { decision: 'allow' })).status).toBe(200);

    const done = await until('completion', async () => {
      const a = (await call('GET', `/api/agents/${id}`)).json;
      return ['completed', 'failed'].includes(a.status) ? a : null;
    });
    expect(done.status, done.statusDetail).toBe('completed');
    expect(readFileSync(path.join(root, 'hello.txt'), 'utf8').trim()).toBe('viscosity-ok');
    expect(done.providerSessionId).toBeTruthy();
    expect(done.outputTokens).toBeGreaterThan(0);

    const events = (await call('GET', `/api/agents/${id}/events`)).json as any[];
    const types = events.map((e) => e.event.type);
    for (const t of ['user', 'tool_use', 'approval_request', 'approval_resolved', 'tool_result', 'file_change', 'usage', 'result']) expect(types, t).toContain(t);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // Git changes are visible through the worker.
    const git = (await call('GET', `/api/agents/${id}/git`)).json;
    expect(git.status.files.some((f: any) => f.path === 'hello.txt')).toBe(true);

    // Follow-up resumes the same provider conversation (it must remember the file it just wrote).
    expect((await call('POST', `/api/agents/${id}/messages`, { prompt: 'Without using any tools: what is the exact filename you created? Answer with only the filename.' })).status).toBe(200);
    await until('follow-up completion', async () => {
      const evs = (await call('GET', `/api/agents/${id}/events`)).json as any[];
      return evs.filter((e) => e.event.type === 'result').length === 2;
    });
    const after = (await call('GET', `/api/agents/${id}/events`)).json as any[];
    const lastText = after.filter((e) => e.event.type === 'text').at(-1).event.text;
    expect(lastText).toContain('hello.txt');
    const agent = (await call('GET', `/api/agents/${id}`)).json;
    console.log('LIVE RESULT', { status: agent.status, events: after.length, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens, costUsd: agent.costUsd });
  }, 400_000);
});
