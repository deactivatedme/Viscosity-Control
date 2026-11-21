/**
 * Deployments against a REAL Docker daemon: compose up, health checks, env secrets, redeploy,
 * rollback, failure reporting, production approvals and teardown. Skipped when Docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { startWorker } from '../../worker/src/worker';
import { loadConfig } from '../src/config';
import { hashPassword, hashToken, newToken } from '../src/crypto';
import { schema } from '../src/db';
import { buildApp } from '../src/server';

const docker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://viscosity:viscosity@127.0.0.1:5432/postgres';
const DB_NAME = `viscosity_deploy_${process.pid}`;
const ORIGIN = 'http://dashboard.test';
const SECRET = 'greeting-secret-8c1f';

/** A one-file HTTP service on alpine: answers every request with "$GREETING $APP_VERSION". */
const composeFile = (port: number, version: string) => `services:
  web:
    image: alpine:3
    stop_grace_period: 1s
    environment:
      GREETING: \${GREETING:-unset}
      APP_VERSION: "${version}"
    command:
      - sh
      - -c
      - 'B="$$GREETING $$APP_VERSION"; while true; do printf "HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s" "$\${#B}" "$$B" | nc -l -p 8080; done'
    ports: ["127.0.0.1:${port}:8080"]
`;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolve(port));
  });
});

describe.skipIf(!docker)('deployments (real Docker)', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  let base = '';
  let root = '';
  let dataDir = '';
  let admin = '';
  let operator = '';
  let viewer = '';
  let serverId = '';
  let port = 0;
  let prodPort = 0;
  let app = '';
  let depId = '';
  let prodId = '';
  const shas: string[] = [];
  const projects: string[] = [];

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
  const commit = (cwd: string, p: number, version: string) => {
    writeFileSync(path.join(cwd, 'docker-compose.yml'), composeFile(p, version));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', `version ${version}`);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  async function call(method: string, url: string, cookie: string, body?: unknown) {
    const res = await fetch(base + url, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  const get = (url: string, cookie = admin) => call('GET', url, cookie);
  const post = (url: string, body: unknown = {}, cookie = admin) => call('POST', url, cookie, body);
  async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 120_000): Promise<T> {
    for (const end = Date.now() + ms; ; ) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  async function session(role: 'operator' | 'viewer') {
    const [u] = await built.ctx.db.insert(schema.users).values({ email: `${role}@test`, passwordHash: await hashPassword('irrelevant-pass'), role }).returning();
    const token = newToken();
    await built.ctx.db.insert(schema.sessions).values({ userId: u!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) });
    return `vc_session=${token}`;
  }
  /** Wait for a release to leave running/pending and return it with the deployment. */
  const settled = (id: string, releaseId: string) => until(`release ${releaseId}`, async () => {
    const d = (await get(`/api/deployments/${id}`)).json;
    const r = d.releases.find((x: any) => x.id === releaseId);
    return r && !['running', 'pending_approval'].includes(r.status) ? { d, r } : null;
  });
  // The service answers one request per `nc` invocation; retry across the gap between two listens.
  const served = (p: number) => until(`response on :${p}`, async () => fetch(`http://127.0.0.1:${p}/`).then((r) => r.text(), () => null), 30_000);
  const containersOf = (project: string) => execFileSync('docker', ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]).toString().trim();

  beforeAll(async () => {
    const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
    await sql.unsafe(`create database ${DB_NAME}`);
    await sql.end();
    root = mkdtempSync(path.join(tmpdir(), 'vc-deploy-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'vc-deploy-data-'));
    built = await buildApp(loadConfig({ DATABASE_URL: ADMIN_DB.replace(/\/[^/]+$/, `/${DB_NAME}`), VISCOSITY_SECRET_KEY: 'deploy-test-key-0123456789abcdef-0123', PUBLIC_ORIGIN: ORIGIN, DATA_DIR: dataDir, LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv));
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    admin = (await call('POST', '/api/setup', '', { email: 'admin@test.dev', password: 'a-long-enough-password' })).cookie;
    operator = await session('operator');
    viewer = await session('viewer');
    const created = await post('/api/servers', { name: 'docker-box' });
    serverId = created.json.server.id;
    const enrolled = await (await fetch(`${base}/api/worker/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: created.json.enrollment.token, protocol: 1, hostname: 'h' }) })).json() as { secret: string };
    worker = await startWorker({ controlUrl: base, serverId, secret: enrolled.secret, roots: [root], dataDir: path.join(dataDir, 'w'), allowRootShell: true });
    await until('online', async () => (await get(`/api/servers/${serverId}`)).json.status === 'online', 15_000);

    [port, prodPort] = [await freePort(), await freePort()];
    app = path.join(root, 'app');
    mkdirSync(app);
    execFileSync('git', ['init', '-q', '-b', 'main', app]);
    shas.push(commit(app, port, 'one'));
  });

  afterAll(async () => {
    // Safety net: anything a failed test left running.
    for (const p of projects) {
      try { execFileSync('docker', ['compose', '-p', p, 'down', '--remove-orphans', '-t', '1'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    await worker?.stop();
    await built?.app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
    await sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await sql.end();
  });

  it('creates a deployment and never returns its secrets', async () => {
    expect((await post('/api/deployments', { name: 'x', serverId, workdir: app, environment: 'staging', composeFile: '../../etc/passwd' }, operator)).status).toBe(400);
    expect((await post('/api/deployments', { name: 'x', serverId, workdir: app, environment: 'staging' }, viewer)).status).toBe(403);
    const res = await post('/api/deployments', { name: 'test web', serverId, workdir: app, environment: 'staging', env: { GREETING: SECRET }, healthUrl: `http://127.0.0.1:${port}/` }, operator);
    expect(res.status, res.text).toBe(200);
    depId = res.json.id;
    projects.push(res.json.composeProject);
    expect(res.json.composeProject).toMatch(/^vc-test-web-[0-9a-f]{8}$/);
    expect(res.json.envKeys).toEqual(['GREETING']);
    expect(res.json.status).toBe('idle');
    expect(res.text).not.toContain(SECRET);
    const [row] = await built.ctx.db.select().from(schema.deployments);
    expect(row!.envEnc).not.toContain(SECRET); // encrypted at rest
  });

  it('deploys with compose, verifies health and records the commit', async () => {
    const rel = await post(`/api/deployments/${depId}/deploy`, {}, operator);
    expect(rel.status, rel.text).toBe(200);
    expect((await post(`/api/deployments/${depId}/deploy`, {}, operator)).status).toBe(409); // one at a time
    const { d, r } = await settled(depId, rel.json.id);
    expect(r.status, r.detail).toBe('succeeded');
    expect(r.version).toBe(shas[0]);
    expect(r.health).toMatchObject({ ok: true, status: 200 });
    expect(r.requestedBy).toBe('operator@test');
    expect(d.status).toBe('healthy');
    expect(d.currentReleaseId).toBe(r.id);
    expect(d.containers).toHaveLength(1);
    expect(d.containers[0]).toMatchObject({ state: 'running', composeProject: d.composeProject });
    expect(await served(port)).toBe(`${SECRET} one`); // the env secret reached the container…
    // …but is in no API response, session log or audit entry
    for (const url of ['/api/deployments', `/api/deployments/${depId}`, `/api/agents/${r.sessionId}/events`, '/api/audit?limit=500', `/api/agents/${r.sessionId}`])
      expect((await get(url)).text, url).not.toContain(SECRET);
    const log = (await get(`/api/agents/${r.sessionId}/events`)).json;
    expect(log.at(-1).event).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('redeploys a new commit, then rolls back to the first release', async () => {
    shas.push(commit(app, port, 'two'));
    const second = await settled(depId, (await post(`/api/deployments/${depId}/deploy`, {}, operator)).json.id);
    expect(second.r.status, second.r.detail).toBe('succeeded');
    expect(second.r.version).toBe(shas[1]);
    await until('version two served', async () => (await served(port)) === `${SECRET} two`);

    const first = second.d.releases.at(-1);
    const back = await post(`/api/deployments/${depId}/rollback`, { releaseId: first.id }, operator);
    expect(back.status, back.text).toBe(200);
    const rolled = await settled(depId, back.json.id);
    expect(rolled.r).toMatchObject({ status: 'succeeded', trigger: 'rollback', version: shas[0] });
    await until('version one served again', async () => (await served(port)) === `${SECRET} one`);
    expect(rolled.d.releases).toHaveLength(3);
  });

  it('changes an environment variable (write-only) and deploys a named branch', async () => {
    const patched = await call('PATCH', `/api/deployments/${depId}`, operator, { env: { GREETING: 'rotated-value-77', EXTRA: 'x' } });
    expect(patched.json.envKeys).toEqual(['EXTRA', 'GREETING']);
    expect(patched.text).not.toContain('rotated-value-77');
    expect((await call('PATCH', `/api/deployments/${depId}`, operator, { env: { EXTRA: null } })).json.envKeys).toEqual(['GREETING']);
    const { r } = await settled(depId, (await post(`/api/deployments/${depId}/deploy`, { version: 'main' }, operator)).json.id);
    expect(r.status, r.detail).toBe('succeeded');
    expect(r.version).toBe(shas[1]);
    await until('new value served', async () => (await served(port)) === 'rotated-value-77 two');
    expect((await post(`/api/deployments/${depId}/deploy`, { version: '--upload-pack=x' }, operator)).status).toBe(400);
  });

  it('notices an unhealthy application and recovers on redeploy', async () => {
    const d = (await get(`/api/deployments/${depId}`)).json;
    expect((await get(`/api/deployments/${depId}/health`)).json.ok).toBe(true);
    expect((await post(`/api/servers/${serverId}/containers/${d.containers[0].id}/stop`)).status).toBe(200);
    const health = (await get(`/api/deployments/${depId}/health`)).json;
    expect(health).toMatchObject({ ok: false, status: null });
    expect((await get(`/api/deployments/${depId}`)).json.status).toBe('unhealthy');
    const { d: after } = await settled(depId, (await post(`/api/deployments/${depId}/deploy`, {}, operator)).json.id);
    expect(after.status).toBe('healthy');
  });

  it('records the real reason when a deploy fails', async () => {
    writeFileSync(path.join(app, 'docker-compose.yml'), 'services:\n  web:\n    image: alpine:3\n    ports: ["not-a-port"]\n');
    const { d, r } = await settled(depId, (await post(`/api/deployments/${depId}/deploy`, {}, operator)).json.id);
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/deploy failed/);
    expect(r.detail).toMatch(/port/i); // compose's own message, not just an exit code
    expect(d.status).toBe('failed');
    git(app, 'checkout', '-q', '--', 'docker-compose.yml');
  });

  it('requires an administrator for production', async () => {
    const prod = path.join(root, 'prod');
    mkdirSync(prod);
    execFileSync('git', ['init', '-q', '-b', 'main', prod]);
    commit(prod, prodPort, 'prod');
    const body = { name: 'test prod', serverId, workdir: prod, environment: 'production', healthUrl: `http://127.0.0.1:${prodPort}/` };
    expect((await post('/api/deployments', body, operator)).status).toBe(403);
    const created = await post('/api/deployments', body);
    prodId = created.json.id;
    projects.push(created.json.composeProject);
    expect((await call('PATCH', `/api/deployments/${prodId}`, operator, { env: { A: 'b' } })).status).toBe(403);

    // an operator can only ask
    const asked = await post(`/api/deployments/${prodId}/deploy`, {}, operator);
    expect(asked.json.status).toBe('pending_approval');
    expect((await get(`/api/deployments/${prodId}`)).json.status).toBe('pending_approval');
    expect(containersOf(created.json.composeProject)).toBe('');
    for (const cookie of [operator, viewer]) expect((await post(`/api/deployments/${prodId}/releases/${asked.json.id}/approve`, {}, cookie)).status).toBe(403);

    expect((await post(`/api/deployments/${prodId}/releases/${asked.json.id}/reject`)).status).toBe(200);
    const rejected = (await get(`/api/deployments/${prodId}`)).json;
    expect(rejected.status).toBe('idle');
    expect(rejected.releases[0]).toMatchObject({ status: 'rejected', requestedBy: 'operator@test', approvedBy: 'admin@test.dev' });
    expect((await post(`/api/deployments/${prodId}/releases/${asked.json.id}/approve`)).status).toBe(409);

    const again = await post(`/api/deployments/${prodId}/deploy`, {}, operator);
    expect((await post(`/api/deployments/${prodId}/releases/${again.json.id}/approve`)).status).toBe(200);
    const { d, r } = await settled(prodId, again.json.id);
    expect(r).toMatchObject({ status: 'succeeded', requestedBy: 'operator@test', approvedBy: 'admin@test.dev' });
    expect(d.status).toBe('healthy');
    expect(await served(prodPort)).toBe('unset prod');
    expect((await post(`/api/deployments/${prodId}/stop`, {}, operator)).status).toBe(403);
  });

  it('stops and tears a deployment down', async () => {
    const d = (await get(`/api/deployments/${depId}`)).json;
    expect((await post(`/api/deployments/${depId}/stop`, {}, operator)).status).toBe(200);
    const stopped = (await get(`/api/deployments/${depId}`)).json;
    expect(stopped.status).toBe('idle');
    expect(stopped.containers[0].state).toBe('exited');
    expect((await call('DELETE', `/api/deployments/${depId}?down=1`, operator)).status).toBe(200);
    expect(containersOf(d.composeProject)).toBe('');
    expect((await get(`/api/deployments/${depId}`)).status).toBe(404);
    expect((await call('DELETE', `/api/deployments/${prodId}?down=1`, admin)).status).toBe(200);
    expect(execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}']).toString()).not.toMatch(/vc-test-(web|prod)/);
    const actions = (await get('/api/audit?limit=500')).json.map((a: any) => a.action);
    for (const a of ['deployment.create', 'deployment.deploy', 'deployment.deploy_requested', 'deployment.rollback', 'deployment.approve', 'deployment.reject', 'deployment.update', 'deployment.stop', 'deployment.delete'])
      expect(actions, a).toContain(a);
  });
});
