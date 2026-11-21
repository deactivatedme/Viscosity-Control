/**
 * Multi-step workflow engine, end to end: real Postgres, real in-process worker, real child
 * processes as steps (custom-provider agents). Nothing is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { startWorker } from '../../worker/src/worker';
import type { WorkerConfig } from '../../worker/src/config';
import { loadConfig } from '../src/config';
import { schema } from '../src/db';
import { buildApp } from '../src/server';
import type { RunState } from '../src/services/workflow-steps';

const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://viscosity:viscosity@127.0.0.1:5432/postgres';
const DB_NAME = `viscosity_wf_${process.pid}`;
const ORIGIN = 'http://dashboard.test';
const env = (dataDir: string, port = '0') => ({
  DATABASE_URL: ADMIN_DB.replace(/\/[^/]+$/, `/${DB_NAME}`), VISCOSITY_SECRET_KEY: 'workflow-test-key-0123456789abcdef-01', PUBLIC_ORIGIN: ORIGIN,
  DATA_DIR: dataDir, LOG_LEVEL: 'warn', PORT: port,
}) as NodeJS.ProcessEnv;

let built: Awaited<ReturnType<typeof buildApp>>;
let worker: Awaited<ReturnType<typeof startWorker>> | null = null;
let workerConfig: WorkerConfig;
let base = '';
let port = 0;
let root = '';
let dataDir = '';
let cookie = '';
let serverId = '';
let LOG = '';

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return { status: res.status, json: json as any };
}
const get = (url: string) => call('GET', url);
const post = (url: string, body: unknown = {}) => call('POST', url, body);

async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; ; ) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** A finished custom-provider agent whose configuration workflow steps can copy. */
async function template(script: string): Promise<{ kind: 'agent'; sessionId: string }> {
  const res = await post('/api/agents', { serverId, provider: 'custom', cwd: root, permissionMode: 'auto', command: ['node', '-e', script], prompt: 'step' });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await until('template to settle', async () => {
    const a = (await get(`/api/agents/${res.json.id}`)).json;
    if (a.status === 'running') await post(`/api/agents/${res.json.id}/stop`); // long-running templates are stopped once they exist
    return ['completed', 'failed', 'stopped'].includes(a.status);
  });
  return { kind: 'agent', sessionId: res.json.id };
}
/** Appends "<name>:start:<ms>" then, after `ms`, "<name>:end:<ms>" to the shared log. */
const mark = (name: string, ms: number) => template(
  `const fs=require('fs');const f=${JSON.stringify(LOG)};fs.appendFileSync(f,'${name}:start:'+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(f,'${name}:end:'+Date.now()+'\\n'),${ms})`);
const logLines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [name, what, at] = l.split(':'); return { name: name!, what: what!, at: Number(at) }; }) : []);
const at = (name: string, what: 'start' | 'end') => logLines().find((l) => l.name === name && l.what === what)!.at;
const count = (name: string) => logLines().filter((l) => l.name === name && l.what === 'start').length;

type StepIn = { id: string; name?: string; from?: unknown; dependsOn?: string[]; retries?: number; timeoutSec?: number };
async function workflow(name: string, steps: StepIn[]) {
  const res = await post('/api/workflows', { name, steps: steps.map((s) => ({ name: s.id, dependsOn: [], retries: 0, ...s })) });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as { id: string };
}
async function start(wfId: string) {
  rmSync(LOG, { force: true });
  const res = await post(`/api/workflows/${wfId}/run`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as { id: string; status: string };
}
const runOf = async (runId: string) => (await get(`/api/workflows/runs/${runId}`)).json as { id: string; status: string; detail: string | null; finishedAt: string | null; state: RunState };
const finished = (runId: string, ms?: number) => until('run to finish', async () => {
  const r = await runOf(runId);
  return ['succeeded', 'failed', 'cancelled'].includes(r.status) ? r : null;
}, ms);
const GATE = { approval: true };

async function boot(listenPort: number) {
  built = await buildApp(loadConfig(env(dataDir)));
  await built.app.listen({ port: listenPort, host: '127.0.0.1' });
  port = (built.app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create database ${DB_NAME}`);
  await sql.end();
  root = mkdtempSync(path.join(tmpdir(), 'vc-wf-root-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'vc-wf-data-'));
  LOG = path.join(root, 'log.txt');
  await boot(0);
  await post('/api/setup', { email: 'wf@test.dev', password: 'a-long-enough-password' });
  const created = await post('/api/servers', { name: 'wf-box' });
  serverId = created.json.server.id;
  const enrolled = await (await fetch(`${base}/api/worker/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: created.json.enrollment.token, protocol: 1, hostname: 'wf' }) })).json() as { secret: string };
  workerConfig = { controlUrl: base, serverId, secret: enrolled.secret, roots: [root], dataDir: path.join(dataDir, 'worker'), metricsIntervalMs: 1000, allowRootShell: true };
  worker = await startWorker(workerConfig);
  await until('server online', async () => (await get(`/api/servers/${serverId}`)).json.status === 'online');
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

describe('definition', () => {
  it('rejects cycles, unknown dependencies, duplicate ids and gate-only workflows', async () => {
    const t = await mark('v', 10);
    const bad = async (steps: unknown[]) => post('/api/workflows', { name: 'bad', steps });
    const s = (id: string, dependsOn: string[] = [], from: unknown = t) => ({ id, name: id, from, dependsOn, retries: 0 });
    const cycle = await bad([s('a', ['c']), s('b', ['a']), s('c', ['b'])]);
    expect(cycle.status).toBe(400);
    expect(cycle.json.error).toMatch(/cycle/);
    expect((await bad([s('a', ['a'])])).json.error).toMatch(/depends on itself/);
    expect((await bad([s('a', ['nope'])])).json.error).toMatch(/unknown step/);
    expect((await bad([s('a'), s('a')])).json.error).toMatch(/duplicate/);
    expect((await bad([s('g', [], GATE)])).json.error).toMatch(/at least one agent or browser step/);
    expect((await bad([{ id: 'x', name: 'x', dependsOn: [], retries: 0 }])).json.error).toMatch(/needs a past run/);
    expect((await bad([{ ...s('a'), retries: 9 }])).status).toBe(400);
    // an agent that asks for per-tool approval cannot run unattended
    await built.ctx.db.update(schema.agentSessions).set({ permissionMode: 'ask', provider: 'claude' }).where(eq(schema.agentSessions.id, t.sessionId));
    expect((await bad([s('a')])).json.error).toMatch(/ask/);
  });

  it('keeps a step\'s captured source when it is edited without choosing a new one', async () => {
    const wf = await workflow('editable', [{ id: 'a', from: await mark('e', 10) }]);
    const res = await call('PATCH', `/api/workflows/${wf.id}`, { steps: [{ id: 'a', name: 'renamed', dependsOn: [], retries: 2, timeoutSec: 60 }, { id: 'g', name: 'gate', from: GATE, dependsOn: ['a'], retries: 0 }] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.steps).toMatchObject([{ id: 'a', name: 'renamed', kind: 'agent', retries: 2, timeoutSec: 60, config: { command: expect.any(Array) } }, { id: 'g', kind: 'approval', dependsOn: ['a'] }]);
  });
});

describe('execution', () => {
  it('runs independent steps in parallel and starts a step only after everything it depends on succeeded', async () => {
    const wf = await workflow('fan-out', [
      { id: 'a', from: await mark('a', 500) }, { id: 'b', from: await mark('b', 500) }, { id: 'join', from: await mark('join', 20), dependsOn: ['a', 'b'] },
    ]);
    const run = await finished((await start(wf.id)).id);
    expect(run.status).toBe('succeeded');
    expect(at('a', 'start')).toBeLessThan(at('b', 'end')); // a and b overlapped
    expect(at('b', 'start')).toBeLessThan(at('a', 'end'));
    expect(at('join', 'start')).toBeGreaterThanOrEqual(Math.max(at('a', 'end'), at('b', 'end')));
    for (const id of ['a', 'b', 'join']) {
      expect(run.state.steps[id]).toMatchObject({ status: 'succeeded', attempts: 1, result: 'exited with code 0' });
      expect(run.state.steps[id]!.sessionIds).toHaveLength(1);
      expect(run.state.steps[id]!.finishedAt).toBeTruthy();
    }
    expect(run.finishedAt).toBeTruthy();
  });

  it('retries a failing step up to its limit', async () => {
    const counter = path.join(root, 'counter');
    const flaky = await template(`const fs=require('fs');const f=${JSON.stringify(counter)};const n=(fs.existsSync(f)?+fs.readFileSync(f):0)+1;fs.writeFileSync(f,String(n));process.exit(n<2?1:0)`);
    const wf = await workflow('flaky', [{ id: 'flaky', from: flaky, retries: 2 }, { id: 'after', from: await mark('after', 10), dependsOn: ['flaky'] }]);
    rmSync(counter, { force: true });
    const run = await finished((await start(wf.id)).id);
    expect(run.status).toBe('succeeded');
    expect(run.state.steps.flaky).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(run.state.steps.flaky!.sessionIds).toHaveLength(2);
    expect(readFileSync(counter, 'utf8')).toBe('2');
  });

  it('fails the run when retries are exhausted, skips dependents, and lets an unrelated running branch finish', async () => {
    const wf = await workflow('doomed', [
      { id: 'bad', from: await template('process.exit(3)'), retries: 1 },
      { id: 'slow', from: await mark('slow', 900) },
      { id: 'after', from: await mark('after', 10), dependsOn: ['bad'] },
      { id: 'later', from: await mark('later', 10), dependsOn: ['slow'] },
    ]);
    const run = await finished((await start(wf.id)).id);
    expect(run.status).toBe('failed');
    expect(run.detail).toMatch(/^bad: /);
    expect(run.state.steps.bad).toMatchObject({ status: 'failed', attempts: 2 });
    expect(run.state.steps.slow).toMatchObject({ status: 'succeeded' }); // was already running: allowed to finish
    expect(run.state.steps.after).toMatchObject({ status: 'skipped', attempts: 0 });
    expect(run.state.steps.later).toMatchObject({ status: 'skipped', attempts: 0 }); // nothing new starts once the run has failed
    expect(count('after') + count('later')).toBe(0);
    expect(logLines().some((l) => l.name === 'slow' && l.what === 'end')).toBe(true);
  });

  it('enforces a per-step timeout', async () => {
    const wf = await workflow('slowpoke', [{ id: 'hang', from: await template('setInterval(()=>{},1000)'), timeoutSec: 1 }]);
    const run = await finished((await start(wf.id)).id);
    expect(run.status).toBe('failed');
    expect(run.state.steps.hang!.result).toMatch(/timed out|time limit|timeout/i);
    const session = (await get(`/api/agents/${run.state.steps.hang!.sessionIds[0]}`)).json;
    expect(['failed', 'stopped']).toContain(session.status);
  });

  it('never runs two overlapping runs of the same workflow', async () => {
    const wf = await workflow('overlap', [{ id: 'hang', from: await template('setInterval(()=>{},1000)') }]);
    const first = await start(wf.id);
    expect(first.status).toBe('running');
    expect((await post(`/api/workflows/${wf.id}/run`)).json).toMatchObject({ status: 'skipped' });
    await post(`/api/workflows/runs/${first.id}/cancel`);
  });
});

describe('approval gates', () => {
  let wfId = '';
  it('pauses at a gate and continues when approved', async () => {
    wfId = (await workflow('gated', [{ id: 'a', from: await mark('a', 10) }, { id: 'gate', from: GATE, dependsOn: ['a'] }, { id: 'c', from: await mark('c', 10), dependsOn: ['gate'] }])).id;
    const { id } = await start(wfId);
    await until('gate', async () => (await runOf(id)).status === 'waiting_approval');
    const pending = (await get('/api/approvals')).json.find((a: any) => a.sessionId === id);
    expect(pending).toMatchObject({ kind: 'workflow', approvalId: 'gate', status: 'pending' });
    expect(count('c')).toBe(0);
    expect((await post(`/api/workflows/runs/${id}/approvals/a`, { decision: 'allow' })).status).toBe(409); // not a gate
    expect((await post(`/api/workflows/runs/${id}/approvals/gate`, { decision: 'allow' })).status).toBe(200);
    const run = await finished(id);
    expect(run.status).toBe('succeeded');
    expect(run.state.steps.gate!.result).toBe('Approved by wf@test.dev');
    expect(count('c')).toBe(1);
    expect((await get('/api/approvals')).json.some((a: any) => a.sessionId === id)).toBe(false);
  });

  it('fails the run when the gate is denied', async () => {
    const { id } = await start(wfId);
    await until('gate', async () => (await runOf(id)).status === 'waiting_approval');
    expect((await post(`/api/workflows/runs/${id}/approvals/gate`, { decision: 'deny' })).status).toBe(200);
    const run = await finished(id);
    expect(run.status).toBe('failed');
    expect(run.state.steps).toMatchObject({ a: { status: 'succeeded' }, gate: { status: 'failed', result: 'Denied by wf@test.dev' }, c: { status: 'skipped' } });
    expect(count('c')).toBe(0);
    const [row] = await built.ctx.db.select().from(schema.approvals).where(and(eq(schema.approvals.sessionId, id), eq(schema.approvals.approvalId, 'gate')));
    expect(row!.status).toBe('denied');
  });
});

describe('cancellation', () => {
  it('stops the running session, expires gates and refuses to cancel twice', async () => {
    const wf = await workflow('cancellable', [
      { id: 'hang', from: await template('setInterval(()=>{},1000)') }, { id: 'gate', from: GATE }, { id: 'never', from: await mark('never', 10), dependsOn: ['hang'] },
    ]);
    const { id } = await start(wf.id);
    const sessionId = await until('session to run', async () => {
      const r = await runOf(id);
      const sid = r.state.steps.hang!.sessionIds[0];
      return sid && (await get(`/api/agents/${sid}`)).json.status === 'running' ? sid : null;
    });
    const res = await post(`/api/workflows/runs/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('cancelled');
    expect(res.json.state.steps).toMatchObject({ hang: { status: 'cancelled' }, gate: { status: 'cancelled' }, never: { status: 'cancelled' } });
    await until('session stopped', async () => (await get(`/api/agents/${sessionId}`)).json.status === 'stopped');
    expect((await get('/api/approvals')).json.some((a: any) => a.sessionId === id)).toBe(false);
    expect((await post(`/api/workflows/runs/${id}/cancel`)).status).toBe(409);
    await new Promise((r) => setTimeout(r, 300));
    expect(count('never')).toBe(0);
  });
});

describe('exactly-once under races and restarts', () => {
  const sessionsNamed = async (name: string) => built.ctx.db.select().from(schema.agentSessions).where(like(schema.agentSessions.name, `${name}%`));
  const pendingRun = async (wfId: string, steps: RunState['steps'] | null = null) => {
    const wf = await built.workflows.get(wfId);
    const def = wf.steps as RunState['def'];
    const state: RunState = { def, name: wf.name, userId: null, steps: steps ?? Object.fromEntries(def.map((s) => [s.id, { status: 'pending' as const, attempts: 0, sessionIds: [] }])) };
    const [run] = await built.ctx.db.insert(schema.workflowRuns).values({ workflowId: wfId, trigger: 'manual', status: 'running', state: state as never }).returning();
    return run!.id;
  };

  it('concurrent advance passes start each step once', async () => {
    const wf = await workflow('racy', [{ id: 'a', from: await mark('ra', 200) }, { id: 'b', from: await mark('rb', 10), dependsOn: ['a'] }]);
    rmSync(LOG, { force: true });
    const id = await pendingRun(wf.id);
    await Promise.all(Array.from({ length: 6 }, () => built.workflows.advance(id)));
    const racing = setInterval(() => void built.workflows.advance(id).catch(() => {}), 20); // keep racing while it progresses
    const run = await finished(id);
    clearInterval(racing);
    expect(run.status).toBe('succeeded');
    expect(run.state.steps.a!.sessionIds).toHaveLength(1);
    expect(run.state.steps.b!.sessionIds).toHaveLength(1);
    expect(await sessionsNamed('racy')).toHaveLength(2);
    expect([count('ra'), count('rb')]).toEqual([1, 1]);
  });

  it('recreates a session that was claimed but never created (crash between claim and create), under its original id', async () => {
    const wf = await workflow('orphan', [{ id: 'a', from: await mark('oa', 10) }]);
    rmSync(LOG, { force: true });
    const claimed = randomUUID();
    const fresh = await pendingRun(wf.id, { a: { status: 'running', attempts: 1, sessionIds: [claimed], claimedAt: new Date().toISOString() } });
    await built.workflows.advance(fresh);
    expect(await sessionsNamed('orphan')).toHaveLength(0); // within the grace period another pass may still be creating it
    await built.ctx.db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.id, fresh));

    const stale = await pendingRun(wf.id, { a: { status: 'running', attempts: 1, sessionIds: [claimed], claimedAt: new Date(Date.now() - 120_000).toISOString() } });
    await Promise.all([built.workflows.advance(stale), built.workflows.advance(stale), built.workflows.advance(stale)]);
    const run = await finished(stale);
    expect(run.status).toBe('succeeded');
    expect(run.state.steps.a).toMatchObject({ attempts: 1, sessionIds: [claimed] });
    expect((await sessionsNamed('orphan')).map((s) => s.id)).toEqual([claimed]);
    expect(count('oa')).toBe(1);
  });

  it('resumes a run on a second control-plane instance without repeating a step', async () => {
    const wf = await workflow('resumable', [{ id: 'a', from: await mark('sa', 1500) }, { id: 'b', from: await mark('sb', 10), dependsOn: ['a'] }]);
    const { id } = await start(wf.id);
    await until('a to start', async () => count('sa') === 1);
    // The control plane goes away mid-run. The step keeps running on the worker.
    await built.app.close();
    await boot(port); // a brand-new instance: nothing in memory, same database, same address
    const run = await finished(id, 45_000);
    expect(run.status).toBe('succeeded');
    expect(run.state.steps).toMatchObject({ a: { status: 'succeeded', attempts: 1 }, b: { status: 'succeeded', attempts: 1 } });
    expect(run.state.steps.a!.sessionIds).toHaveLength(1);
    expect([count('sa'), count('sb')]).toEqual([1, 1]);
    expect(await sessionsNamed('resumable')).toHaveLength(2);
  });

  it('enforces the timeout itself when the server is offline and the session never starts', async () => {
    const wf = await workflow('stranded', [{ id: 'a', from: await mark('st', 10), timeoutSec: 1 }]);
    await worker!.stop();
    worker = null;
    await until('offline', async () => (await get(`/api/servers/${serverId}`)).json.status === 'offline');
    const { id } = await start(wf.id);
    const run = await finished(id, 30_000);
    expect(run.status).toBe('failed');
    expect(run.state.steps.a!.result).toBe('timed out after 1s');
    // The run is recorded as failed first; the queued session is cancelled right after that commit.
    await until('queued session cancelled', async () => (await get(`/api/agents/${run.state.steps.a!.sessionIds[0]}`)).json.status === 'stopped');
    expect(count('st')).toBe(0);
    writeFileSync(LOG, '');
  });
});
