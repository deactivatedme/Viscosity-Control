/** Shared scaffolding for integration suites: throwaway database, real API, real in-process worker. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
export const ORIGIN = 'http://dashboard.test';

export async function createStack(name: string, opts: { env?: Record<string, string>; worker?: Partial<WorkerConfig> } = {}) {
  const dbName = `viscosity_${name}_${process.pid}`;
  const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create database ${dbName}`);
  await sql.end();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `vc-${name}-root-`)));
  const dataDir = mkdtempSync(path.join(tmpdir(), `vc-${name}-data-`));
  const built = await buildApp(loadConfig({
    DATABASE_URL: ADMIN_DB.replace(/\/[^/]+$/, `/${dbName}`), VISCOSITY_SECRET_KEY: 'integration-test-key-0123456789abcdef', PUBLIC_ORIGIN: ORIGIN,
    DATA_DIR: dataDir, LOG_LEVEL: 'warn', ...opts.env,
  } as NodeJS.ProcessEnv));
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;

  async function call(method: string, url: string, o: { body?: unknown; cookie?: string; origin?: string | null } = {}) {
    const headers: Record<string, string> = {};
    if (o.cookie) headers.cookie = o.cookie;
    if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  const setup = await call('POST', '/api/setup', { body: { email: 'admin@test.dev', password: 'a-long-enough-password' } });
  const admin = setup.cookie;
  const get = (url: string, cookie = admin) => call('GET', url, { cookie });
  const post = (url: string, body: unknown = {}, cookie = admin) => call('POST', url, { body, cookie });

  async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 20_000): Promise<T> {
    for (const end = Date.now() + ms; ; ) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** A signed-in user with the given role, created directly in the database. */
  async function userWithRole(role: 'operator' | 'viewer' | 'admin', email = `${role}@test.dev`) {
    const [u] = await built.ctx.db.insert(schema.users).values({ email, passwordHash: await hashPassword('irrelevant-pass'), role }).returning();
    const token = newToken();
    await built.ctx.db.insert(schema.sessions).values({ userId: u!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) });
    return `vc_session=${token}`;
  }

  // Enroll and connect a real worker.
  const created = await post('/api/servers', { name: `${name}-box` });
  const serverId: string = created.json.server.id;
  const enrolled = await call('POST', '/api/worker/enroll', { body: { token: created.json.enrollment.token, protocol: 1, hostname: name }, origin: null });
  const workerConfig: WorkerConfig = {
    controlUrl: base, serverId, secret: enrolled.json.secret, roots: [root], dataDir: path.join(dataDir, 'worker'),
    metricsIntervalMs: 250, allowRootShell: true, browser: { allowHosts: ['127.0.0.1'] }, ...opts.worker,
  };
  let worker = await startWorker(workerConfig);
  await until('worker online', async () => (await get(`/api/servers/${serverId}`)).json.status === 'online');

  async function cleanup() {
    await worker.stop();
    await built.app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    const s = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
    await s.unsafe(`drop database if exists ${dbName} with (force)`);
    await s.end();
  }
  return { built, base, root, serverId, admin, call, get, post, until, userWithRole, cleanup, workerConfig, get worker() { return worker; }, set worker(w) { worker = w; } };
}
export type Stack = Awaited<ReturnType<typeof createStack>>;
