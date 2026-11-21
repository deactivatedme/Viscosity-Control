/**
 * End-to-end through the real stack: Fastify API + Postgres + an in-process worker
 * speaking the real protocol over a real WebSocket. Nothing is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { startWorker } from '../../worker/src/worker';
import type { WorkerConfig } from '../../worker/src/config';
import { loadConfig } from '../src/config';
import { hashPassword, hashToken, newToken } from '../src/crypto';
import { schema } from '../src/db';
import { buildApp } from '../src/server';

const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://viscosity:viscosity@127.0.0.1:5432/postgres';
const DB_NAME = `viscosity_test_${process.pid}`;
const ORIGIN = 'http://dashboard.test';

let built: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let root: string;
let dataDir: string;
let site: HttpServer;
let siteUrl: string;
let worker: Awaited<ReturnType<typeof startWorker>> | null = null;
let workerConfig: WorkerConfig;
let admin = ''; // session cookie
let serverId = '';

async function call(method: string, url: string, opts: { body?: unknown; cookie?: string; origin?: string | null; raw?: Buffer } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.raw) headers['content-type'] = 'application/octet-stream';
  const res = await fetch(base + url, { method, headers, body: opts.raw ? new Uint8Array(opts.raw) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
const get = (url: string, cookie = admin) => call('GET', url, { cookie });
const post = (url: string, body: unknown = {}, cookie = admin) => call('POST', url, { body, cookie });

async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function userWithRole(role: 'operator' | 'viewer') {
  const [u] = await built.ctx.db.insert(schema.users).values({ email: `${role}@test`, passwordHash: await hashPassword('irrelevant-pass'), role }).returning();
  const token = newToken();
  await built.ctx.db.insert(schema.sessions).values({ userId: u!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) });
  return `vc_session=${token}`;
}

beforeAll(async () => {
  const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create database ${DB_NAME}`);
  await sql.end();

  root = mkdtempSync(path.join(tmpdir(), 'vc-root-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'vc-data-'));
  built = await buildApp(loadConfig({
    DATABASE_URL: ADMIN_DB.replace(/\/[^/]+$/, `/${DB_NAME}`), VISCOSITY_SECRET_KEY: 'integration-test-key-0123456789abcdef', PUBLIC_ORIGIN: ORIGIN,
    DATA_DIR: dataDir, LOG_LEVEL: 'warn', PORT: '0',
  } as NodeJS.ProcessEnv));
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;

  // a tiny site for the browser session to drive
  site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<html><title>Test page</title><body><h1 id="h">Hello</h1>
      <input id="name"><button id="go" onclick="document.getElementById('out').textContent='Hi ' + document.getElementById('name').value">Go</button>
      <p id="out"></p></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await worker?.stop();
  await built?.app.close();
  await new Promise((r) => site?.close(r));
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
  await sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
  await sql.end();
});

describe('authentication and authorization', () => {
  it('requires a session for everything except the public endpoints', async () => {
    expect((await call('GET', '/api/servers')).status).toBe(401);
    expect((await call('GET', '/api/does-not-exist')).status).toBe(401);
    expect((await call('GET', '/api/setup/status')).json).toMatchObject({ needsSetup: true });
  });

  it('creates the administrator exactly once', async () => {
    expect((await call('POST', '/api/setup', { body: { email: 'a@test.dev', password: 'short' } })).status).toBe(400);
    const res = await call('POST', '/api/setup', { body: { email: 'Admin@Test.dev', password: 'a-long-enough-password' } });
    expect(res.status).toBe(200);
    admin = res.cookie;
    expect(admin).toMatch(/^vc_session=/);
    expect((await call('POST', '/api/setup', { body: { email: 'evil@test.dev', password: 'a-long-enough-password' } })).status).toBe(409);
    expect((await get('/api/auth/me')).json).toMatchObject({ email: 'admin@test.dev', role: 'admin', mfaEnabled: false });
  });

  it('rejects cross-origin and origin-less mutations (CSRF)', async () => {
    expect((await call('POST', '/api/servers', { body: { name: 'x' }, cookie: admin, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/servers', { body: { name: 'x' }, cookie: admin, origin: null })).status).toBe(403);
  });

  it('rejects bad credentials without revealing which part was wrong', async () => {
    const a = await call('POST', '/api/auth/login', { body: { email: 'admin@test.dev', password: 'wrong-password-here' } });
    const b = await call('POST', '/api/auth/login', { body: { email: 'nobody@test.dev', password: 'wrong-password-here' } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json.error).toBe(b.json.error);
  });

  it('enforces roles on the server side', async () => {
    const viewer = await userWithRole('viewer');
    const operator = await userWithRole('operator');
    expect((await get('/api/servers', viewer)).status).toBe(200);
    expect((await post('/api/servers', { name: 'nope' }, viewer)).status).toBe(403);
    expect((await post('/api/agents', {}, viewer)).status).toBe(403);
    expect((await post('/api/servers', { name: 'nope' }, operator)).status).toBe(403); // enrolling servers is admin-only
    expect((await post('/api/credentials', { kind: 'anthropic', label: 'x', secret: 'sk-ant-12345678' }, operator)).status).toBe(403);
    expect((await get('/api/audit', operator)).status).toBe(403);
  });

  it('supports TOTP MFA end to end', async () => {
    const { totp } = await import('../src/crypto');
    const setup = await post('/api/auth/mfa/setup');
    expect(setup.json.otpauthUrl).toContain('otpauth://totp/');
    expect((await post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await post('/api/auth/mfa/enable', { code: totp(setup.json.secret) })).status).toBe(200);
    const noCode = await call('POST', '/api/auth/login', { body: { email: 'admin@test.dev', password: 'a-long-enough-password' } });
    expect(noCode.status).toBe(401);
    expect(noCode.json.mfaRequired).toBe(true);
    const withCode = await call('POST', '/api/auth/login', { body: { email: 'admin@test.dev', password: 'a-long-enough-password', code: totp(setup.json.secret) } });
    expect(withCode.status).toBe(200);
    expect((await post('/api/auth/mfa/disable', { password: 'a-long-enough-password', code: totp(setup.json.secret) })).status).toBe(200);
  });
});

describe('worker enrollment', () => {
  let token = '';
  it('issues a single-use enrollment command', async () => {
    const res = await post('/api/servers', { name: 'test-box' });
    expect(res.status).toBe(200);
    serverId = res.json.server.id;
    token = res.json.enrollment.token;
    expect(res.json.server.status).toBe('pending');
    expect(res.json.enrollment.command).toContain(token);
    // only the hash is stored
    const rows = await built.ctx.db.select().from(schema.enrollmentTokens);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('rejects unknown tokens, accepts the real one once, then rejects reuse', async () => {
    const enroll = (t: string) => call('POST', '/api/worker/enroll', { body: { token: t, protocol: 1, hostname: 'h' }, origin: null });
    expect((await enroll('x'.repeat(43))).status).toBe(401);
    const ok = await enroll(token);
    expect(ok.status).toBe(200);
    expect(ok.json.serverId).toBe(serverId);
    expect((await enroll(token)).status).toBe(401);
    workerConfig = { controlUrl: base, serverId, secret: ok.json.secret, roots: [root], dataDir: path.join(dataDir, 'worker'), metricsIntervalMs: 250, allowRootShell: true, browser: { allowHosts: ['127.0.0.1'] } };
    const [row] = await built.ctx.db.select().from(schema.servers).where(eq(schema.servers.id, serverId));
    expect(row!.credentialHash).not.toContain(ok.json.secret);
  });

  it('refuses a worker socket with a wrong credential', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/worker', { headers: { authorization: `Bearer ${serverId}.not-the-secret` } } as never);
    const outcome = await new Promise<string>((r) => { ws.onopen = () => r('open'); ws.onerror = () => r('error'); });
    expect(outcome).toBe('error');
    expect((await get(`/api/servers/${serverId}`)).json.status).not.toBe('online');
  });

  it('comes online with real system information and live metrics', async () => {
    worker = await startWorker(workerConfig);
    const s = await until('server online with metrics', async () => {
      const r = await get(`/api/servers/${serverId}`);
      return r.json.status === 'online' && r.json.metrics ? r.json : null;
    });
    expect(s.system.hostname.length).toBeGreaterThan(0);
    expect(s.system.cpuCores).toBeGreaterThan(0);
    expect(s.metrics.memTotal).toBeGreaterThan(1024 * 1024);
    expect(s.metrics.cpu).toBeGreaterThanOrEqual(0);
    expect(s.connections).toHaveLength(1);
  });
});

describe('remote operations', () => {
  it('reads and writes files inside the allowed root only', async () => {
    const file = path.join(root, 'notes.txt');
    expect((await call('PUT', `/api/servers/${serverId}/fs/write`, { body: { path: file, content: 'hello worker' }, cookie: admin })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('hello worker');
    expect((await get(`/api/servers/${serverId}/fs/read?path=${encodeURIComponent(file)}`)).json.content).toBe('hello worker');
    const up = await call('PUT', `/api/servers/${serverId}/fs/upload?path=${encodeURIComponent(path.join(root, 'blob.bin'))}`, { raw: Buffer.alloc(700_000, 7), cookie: admin });
    expect(up.json).toMatchObject({ ok: true, bytes: 700_000 });
    const list = await get(`/api/servers/${serverId}/fs/list?path=${encodeURIComponent(root)}`);
    expect(list.json.map((e: any) => e.name).sort()).toEqual(['blob.bin', 'notes.txt']);
    expect(list.json.find((e: any) => e.name === 'blob.bin').size).toBe(700_000);
  });

  it('blocks path traversal and paths outside the root', async () => {
    for (const p of ['/etc/passwd', `${root}/../../etc/passwd`, '/root/.ssh/id_rsa']) {
      const r = await get(`/api/servers/${serverId}/fs/read?path=${encodeURIComponent(p)}`);
      expect(r.status, p).toBe(403);
    }
    expect((await call('PUT', `/api/servers/${serverId}/fs/write`, { body: { path: '/tmp/vc-escape.txt', content: 'x' }, cookie: admin })).status).toBe(403);
  });

  it('lists real processes', async () => {
    const r = await get(`/api/servers/${serverId}/processes`);
    expect(r.status).toBe(200);
    expect(r.json.some((p: any) => p.pid === process.pid)).toBe(true);
  });

  it('runs an interactive terminal and refuses foreign origins', async () => {
    const term = (await post(`/api/servers/${serverId}/terminals`, { cols: 100, rows: 30 })).json;
    expect(term.status).toBe('open');
    const url = base.replace('http', 'ws') + `/ws/terminal/${term.id}`;

    const evil = new WebSocket(url, { headers: { cookie: admin, origin: 'https://evil.example' } } as never);
    expect(await new Promise<string>((r) => { evil.onopen = () => r('open'); evil.onerror = () => r('error'); })).toBe('error');

    const ws = new WebSocket(url, { headers: { cookie: admin, origin: ORIGIN } } as never);
    ws.binaryType = 'arraybuffer';
    let out = '';
    let exit: any = null;
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t === 'exit') exit = m; }
      else out += Buffer.from(e.data as ArrayBuffer).toString();
    };
    await new Promise((r) => (ws.onopen = r));
    ws.send(new TextEncoder().encode('echo vc-$((40+2))\n'));
    await until('terminal output', async () => out.includes('vc-42'));
    ws.send(new TextEncoder().encode('exit 3\n'));
    await until('terminal exit', async () => exit);
    expect(exit.exitCode).toBe(3);
    ws.close();
  });
});

describe('agents', () => {
  const script = 'console.log("line one"); setTimeout(() => { console.error("warn"); console.log("done:" + process.argv.at(-1)); }, 300)';
  let agentId = '';

  it('runs a supervised agent and streams + persists its events in order', async () => {
    const res = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', script], prompt: 'the task' });
    expect(res.status).toBe(200);
    agentId = res.json.id;
    const done = await until('agent completion', async () => {
      const a = (await get(`/api/agents/${agentId}`)).json;
      return a.status === 'completed' ? a : null;
    });
    expect(done.endedAt).toBeTruthy();
    const events = (await get(`/api/agents/${agentId}/events`)).json;
    expect(events.map((e: any) => e.seq)).toEqual(events.map((_: any, i: number) => i + 1));
    const text = events.filter((e: any) => e.event.type === 'output').map((e: any) => e.event.text).join('');
    expect(text).toContain('line one');
    expect(text).toContain('done:the task');
    expect(events[0].event).toMatchObject({ type: 'user', text: 'the task' });
    expect(events.at(-1).event).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('refuses work outside the allowed root and reports the real failure', async () => {
    const res = await post('/api/agents', { serverId, provider: 'custom', cwd: '/etc', permissionMode: 'auto', command: ['node', '-v'], prompt: 'x' });
    expect(res.status).toBe(403);
    const list = (await get('/api/agents')).json;
    expect(list.find((a: any) => a.cwd === '/etc').status).toBe('failed');
  });

  it('only offers resume where the provider supports it', async () => {
    const r = await post(`/api/agents/${agentId}/messages`, { prompt: 'again' });
    expect(r.status).toBe(400);
    expect((await post(`/api/agents/${agentId}/restart`)).status).toBe(200);
    await until('restart completion', async () => (await get(`/api/agents/${agentId}/events`)).json.filter((e: any) => e.event.type === 'status' && e.event.status === 'completed').length === 2);
  });

  it('stops a running agent', async () => {
    const res = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', 'setInterval(() => console.log("tick"), 100)'], prompt: 'loop' });
    await until('running', async () => (await get(`/api/agents/${res.json.id}`)).json.status === 'running');
    expect((await post(`/api/agents/${res.json.id}/stop`)).status).toBe(200);
    await until('stopped', async () => (await get(`/api/agents/${res.json.id}`)).json.status === 'stopped');
  });
});

describe('browser sessions', () => {
  it('drives a real browser, verifies actions and stores screenshots on disk', async () => {
    const res = await post('/api/browser', {
      serverId, mode: 'steps', name: 'form test',
      steps: [{ action: 'goto', url: siteUrl }, { action: 'fill', selector: '#name', value: 'Ada' }, { action: 'click', selector: '#go' }, { action: 'extract', selector: '#out' }, { action: 'screenshot' }],
    });
    expect(res.status).toBe(200);
    const done = await until('browser completion', async () => {
      const b = (await get(`/api/browser/${res.json.id}`)).json;
      return ['completed', 'failed'].includes(b.status) ? b : null;
    }, 45_000);
    expect(done.status, done.statusDetail).toBe('completed');
    expect(JSON.stringify(done.result)).toContain('Hi Ada');
    const events = (await get(`/api/browser/${res.json.id}/events`)).json;
    const fill = events.find((e: any) => e.event.type === 'action' && e.event.action === 'fill');
    expect(fill.event.ok).toBe(true);
    expect(fill.event.verified).toBeTruthy();
    const shot = events.find((e: any) => e.event.type === 'screenshot');
    expect(shot.event.data).toBeUndefined(); // bytes are not in Postgres
    const img = await fetch(`${base}/api/browser/${res.json.id}/screenshots/${shot.seq}`, { headers: { cookie: admin } });
    expect(img.status).toBe(200);
    expect(Buffer.from(await img.arrayBuffer()).subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG magic
  });

  it('blocks the cloud metadata address (SSRF)', async () => {
    const res = await post('/api/browser', { serverId, mode: 'steps', steps: [{ action: 'goto', url: 'http://169.254.169.254/latest/meta-data/' }] });
    const done = await until('blocked session to finish', async () => {
      const b = (await get(`/api/browser/${res.json.id}`)).json;
      return ['completed', 'failed'].includes(b.status) ? b : null;
    }, 45_000);
    expect(done.status).toBe('failed');
    const events = (await get(`/api/browser/${res.json.id}/events`)).json;
    expect(events.some((e: any) => e.event.type === 'blocked')).toBe(true);
  });
});

describe('scheduled workflows', () => {
  let wfId = '';
  let templateId = '';

  it('captures a finished agent as a workflow and validates the schedule', async () => {
    const a = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', 'console.log("scheduled run ok")'], prompt: 'nightly' });
    templateId = a.json.id;
    await until('template completion', async () => (await get(`/api/agents/${templateId}`)).json.status === 'completed');
    expect((await post('/api/workflows', { name: 'bad', from: { kind: 'agent', sessionId: templateId }, schedule: 'not a cron' })).status).toBe(400);
    const res = await post('/api/workflows', { name: 'nightly check', from: { kind: 'agent', sessionId: templateId }, schedule: '0 3 * * *', timezone: 'Europe/Berlin' });
    expect(res.status).toBe(200);
    wfId = res.json.id;
    expect(new Date(res.json.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.json.config.command).toEqual(['node', '-e', 'console.log("scheduled run ok")']);
  });

  it('fires a due workflow exactly once, advances the schedule and records the run', async () => {
    // Make it overdue, as if the API had been down across its slot.
    await built.ctx.db.update(schema.workflows).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.workflows.id, wfId));
    const [a, b] = await Promise.all([built.workflows.tick(), built.workflows.tick()]); // two "replicas" racing
    expect(a + b).toBe(1);
    const wf = (await get('/api/workflows')).json.find((w: any) => w.id === wfId);
    expect(new Date(wf.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const run = await until('run outcome', async () => {
      const runs = (await get(`/api/workflows/${wfId}/runs`)).json;
      return runs[0]?.status === 'succeeded' ? runs : null;
    });
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded' });
    const events = (await get(`/api/agents/${run[0].sessionId}/events`)).json;
    expect(events.map((e: any) => e.event.text ?? '').join('')).toContain('scheduled run ok');
  });

  it('runs on demand, can be disabled, and refuses unattended approval modes', async () => {
    expect((await post(`/api/workflows/${wfId}/run`)).json.status).toBe('running');
    const off = await call('PATCH', `/api/workflows/${wfId}`, { body: { enabled: false }, cookie: admin });
    expect(off.json).toMatchObject({ enabled: false, nextRunAt: null });
    await built.ctx.db.update(schema.agentSessions).set({ permissionMode: 'ask', provider: 'claude' }).where(eq(schema.agentSessions.id, templateId));
    expect((await post('/api/workflows', { name: 'x', from: { kind: 'agent', sessionId: templateId }, schedule: '* * * * *' })).status).toBe(400);
    await built.ctx.db.update(schema.agentSessions).set({ permissionMode: 'auto', provider: 'custom' }).where(eq(schema.agentSessions.id, templateId));
  });
});

describe('secrets', () => {
  it('stores provider keys encrypted and never returns them', async () => {
    const secret = 'sk-ant-api03-very-secret-value-1234';
    const res = await post('/api/credentials', { kind: 'anthropic', label: 'main', secret });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toContain('very-secret');
    expect(res.json.hint).toBe('…1234');
    expect(JSON.stringify((await get('/api/credentials')).json)).not.toContain('very-secret');
    const rows = await built.ctx.db.select().from(schema.credentials);
    expect(JSON.stringify(rows)).not.toContain('very-secret');
    expect(built.ctx.box.decrypt(rows[0]!.secretEnc)).toBe(secret);
  });
});

describe('disconnects and recovery', () => {
  it('shows a disconnected worker as offline and fails operations honestly', async () => {
    await worker!.stop();
    worker = null;
    await until('offline', async () => (await get(`/api/servers/${serverId}`)).json.status === 'offline', 5_000);
    const r = await get(`/api/servers/${serverId}/processes`);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('offline');
    expect((await get(`/api/servers/${serverId}`)).json.metrics).toBeNull();
  });

  it('queues an agent while the server is offline and runs it on reconnect', async () => {
    const res = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', 'console.log("ran after reconnect")'], prompt: 'queued' });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('queued');
    worker = await startWorker(workerConfig);
    await until('queued agent to complete', async () => (await get(`/api/agents/${res.json.id}`)).json.status === 'completed');
    const events = (await get(`/api/agents/${res.json.id}/events`)).json;
    expect(events.map((e: any) => e.event.text ?? '').join('')).toContain('ran after reconnect');
  });

  it('replays events produced while the control plane could not hear the worker', async () => {
    const res = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', 'let n = 0; setInterval(() => console.log("tick " + ++n), 40)'], prompt: 'long' });
    const id = res.json.id;
    await until('running', async () => (await get(`/api/agents/${id}`)).json.status === 'running');
    // Drop the link from the control-plane side. The agent keeps running on the worker and keeps logging locally.
    built.ctx.hub.disconnect(serverId, 'simulated network drop');
    await until('offline', async () => (await get(`/api/servers/${serverId}`)).json.status === 'offline', 5_000);
    const before = (await get(`/api/agents/${id}`)).json;
    expect(before.status).toBe('running'); // last known state; the server itself is shown offline
    expect(before.serverOnline).toBe(false);
    await until('worker reconnect', async () => (await get(`/api/servers/${serverId}`)).json.status === 'online', 15_000);
    await until('missed events replayed', async () => (await get(`/api/agents/${id}`)).json.lastSeq > before.lastSeq + 10);
    expect((await post(`/api/agents/${id}/stop`)).status).toBe(200);
    await until('stopped', async () => (await get(`/api/agents/${id}`)).json.status === 'stopped');
    const events = (await get(`/api/agents/${id}/events?limit=2000`)).json;
    expect(events.map((e: any) => e.seq)).toEqual(events.map((_: any, i: number) => i + 1)); // no gaps, no duplicates
    const ticks = events.filter((e: any) => e.event.type === 'output').flatMap((e: any) => e.event.text.match(/tick \d+/g) ?? []);
    expect(ticks).toEqual(ticks.map((_: string, i: number) => `tick ${i + 1}`)); // nothing lost across the outage
  });

  it('marks a session lost when the worker comes back without it', async () => {
    const res = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', 'setInterval(() => {}, 1000)'], prompt: 'will be lost' });
    const id = res.json.id;
    await until('running', async () => (await get(`/api/agents/${id}`)).json.status === 'running');
    // Simulate a worker crash: its record of the session disappears while the API still believes it is running.
    await built.ctx.db.update(schema.agentSessions).set({ status: 'running' }).where(eq(schema.agentSessions.id, id));
    await worker!.stop();
    rmSync(path.join(workerConfig.dataDir, 'agents', `${id}.jsonl`), { force: true });
    await built.ctx.db.update(schema.agentSessions).set({ status: 'running', endedAt: null }).where(eq(schema.agentSessions.id, id));
    worker = await startWorker(workerConfig);
    await until('lost', async () => (await get(`/api/agents/${id}`)).json.status === 'lost');
  });

  it('cuts off a worker whose credential is revoked', async () => {
    expect((await post(`/api/servers/${serverId}/revoke`)).status).toBe(200);
    await until('offline after revoke', async () => (await get(`/api/servers/${serverId}`)).json.status !== 'online', 5_000);
    await new Promise((r) => setTimeout(r, 2500)); // give the worker time to try reconnecting with the dead credential
    expect((await get(`/api/servers/${serverId}`)).json.status).toBe('pending');
  });

  it('wrote an audit trail', async () => {
    const actions = (await get('/api/audit?limit=500')).json.map((a: any) => a.action);
    for (const a of ['setup.admin_created', 'auth.login_failed', 'server.created', 'worker.enrolled', 'worker.enroll_rejected', 'worker.auth_rejected', 'fs.write', 'terminal.open', 'agent.create', 'agent.stop', 'browser.create', 'credential.create', 'server.credential_revoked'])
      expect(actions, a).toContain(a);
  });
});
