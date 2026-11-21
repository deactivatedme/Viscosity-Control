/**
 * Projects + GitHub through the real stack: API + Postgres + in-process worker + real git.
 * GitHub itself is a fake HTTP server (GITHUB_API_URL); the clone source is a real repository
 * served over git's dumb HTTP protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { startWorker } from '../../worker/src/worker';
import { loadConfig } from '../src/config';
import { hashPassword, hashToken, newToken } from '../src/crypto';
import { schema } from '../src/db';
import { buildApp } from '../src/server';

const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://viscosity:viscosity@127.0.0.1:5432/postgres';
const DB_NAME = `viscosity_projects_${process.pid}`;
const ORIGIN = 'http://dashboard.test';
const TOKEN = 'ghp_test_token_0123456789';

let built: Awaited<ReturnType<typeof buildApp>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let base = '';
let admin = '';
let viewer = '';
let serverId = '';
let root = '';
let dataDir = '';
let remote = ''; // served over dumb HTTP + holds the pushable bare origin
let fake: HttpServer;
let fakeUrl = '';
const github: { auth: string[]; pulls: any[]; gitAuth: string[] } = { auth: [], pulls: [], gitAuth: [] };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

async function call(method: string, url: string, body?: unknown, cookie = admin) {
  const res = await fetch(base + url, { method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; ; ) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
  await sql.unsafe(`create database ${DB_NAME}`);
  await sql.end();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vc-proj-root-')));
  dataDir = mkdtempSync(path.join(tmpdir(), 'vc-proj-data-'));
  remote = realpathSync(mkdtempSync(path.join(tmpdir(), 'vc-proj-remote-')));

  // The "GitHub repository": a bare repo (also the push target) exposed read-only over dumb HTTP.
  const src = path.join(remote, 'src');
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  writeFileSync(path.join(src, 'README.md'), '# demo\n');
  git(src, 'add', '-A');
  git(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first commit');
  execFileSync('git', ['clone', '-q', '--bare', src, path.join(remote, 'repo.git')]);
  git(path.join(remote, 'repo.git'), 'update-server-info');

  // One server plays both GitHub's REST API and the git remote.
  fake = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/user/repos') {
      github.auth.push(req.headers.authorization ?? '');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
      return json(200, [{ full_name: 'acme/demo', private: true, default_branch: 'main', clone_url: `${fakeUrl}/repo.git`, description: 'Demo repo', pushed_at: '2026-01-01T00:00:00Z' }]);
    }
    if (url.pathname === '/repos/acme/demo/pulls' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => { github.pulls.push({ auth: req.headers.authorization, body: JSON.parse(raw) }); json(201, { html_url: 'https://github.test/acme/demo/pull/7', number: 7 }); });
      return;
    }
    if (req.headers.authorization) github.gitAuth.push(req.headers.authorization);
    const file = path.join(remote, decodeURIComponent(url.pathname));
    if (!file.startsWith(remote) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  built = await buildApp(loadConfig({
    DATABASE_URL: ADMIN_DB.replace(/\/[^/]+$/, `/${DB_NAME}`), VISCOSITY_SECRET_KEY: 'projects-test-key-0123456789abcdef-01', PUBLIC_ORIGIN: ORIGIN,
    DATA_DIR: dataDir, LOG_LEVEL: 'warn', GITHUB_API_URL: fakeUrl,
  } as NodeJS.ProcessEnv));
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;

  admin = (await call('POST', '/api/setup', { email: 'admin@test.dev', password: 'a-long-enough-password' }, '')).cookie;
  const [u] = await built.ctx.db.insert(schema.users).values({ email: 'viewer@test', passwordHash: await hashPassword('irrelevant-pass'), role: 'viewer' }).returning();
  const t = newToken();
  await built.ctx.db.insert(schema.sessions).values({ userId: u!.id, tokenHash: hashToken(t), expiresAt: new Date(Date.now() + 3600_000) });
  viewer = `vc_session=${t}`;

  const created = await call('POST', '/api/servers', { name: 'proj-box' });
  serverId = created.json.server.id;
  const enrolled = await (await fetch(`${base}/api/worker/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: created.json.enrollment.token, protocol: 1, hostname: 'h' }) })).json() as { secret: string };
  worker = await startWorker({ controlUrl: base, serverId, secret: enrolled.secret, roots: [root], dataDir: path.join(dataDir, 'w'), allowRootShell: true });
  await until('online', async () => (await call('GET', `/api/servers/${serverId}`)).json.status === 'online');
});

afterAll(async () => {
  await worker?.stop();
  await built?.app.close();
  await new Promise((r) => fake?.close(r));
  for (const d of [root, dataDir, remote]) rmSync(d, { recursive: true, force: true });
  const sql = postgres(ADMIN_DB, { max: 1, onnotice: () => {} });
  await sql.unsafe(`drop database if exists ${DB_NAME} with (force)`);
  await sql.end();
});

describe('GitHub', () => {
  let goodCred = '';
  it('lists the token\'s repositories and sends it only as a bearer header', async () => {
    goodCred = (await call('POST', '/api/credentials', { kind: 'github', label: 'gh', secret: TOKEN })).json.id;
    const res = await call('GET', `/api/github/repos?credentialId=${goodCred}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual([{ fullName: 'acme/demo', private: true, defaultBranch: 'main', cloneUrl: `${fakeUrl}/repo.git`, description: 'Demo repo', pushedAt: '2026-01-01T00:00:00Z' }]);
    expect(github.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(res.json)).not.toContain(TOKEN);
  });

  it('reports a rejected token as a clear client error, not a 500 or a session expiry', async () => {
    const bad = (await call('POST', '/api/credentials', { kind: 'github', label: 'bad', secret: 'ghp_wrong_wrong' })).json.id;
    const res = await call('GET', `/api/github/repos?credentialId=${bad}`);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/GitHub rejected this token/);
    const anthropic = (await call('POST', '/api/credentials', { kind: 'anthropic', label: 'a', secret: 'sk-ant-12345678' })).json.id;
    expect((await call('GET', `/api/github/repos?credentialId=${anthropic}`)).status).toBe(400);
  });
});

describe('projects', () => {
  let id = '';
  let dir = '';
  let cred = '';

  it('clones a repository onto the server; the token is used but never persisted', async () => {
    cred = (await call('GET', '/api/credentials')).json.find((c: any) => c.label === 'gh').id;
    dir = path.join(root, 'demo');
    const res = await call('POST', '/api/projects', { serverId, name: 'demo', path: dir, mode: 'clone', cloneUrl: `${fakeUrl}/repo.git`, repoFullName: 'acme/demo', credentialId: cred });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    id = res.json.id;
    expect(res.json).toMatchObject({ name: 'demo', defaultBranch: 'main', repoFullName: 'acme/demo', serverOnline: true });
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# demo\n');
    expect(github.gitAuth.some((h) => Buffer.from(h.replace('Basic ', ''), 'base64').toString() === `x-access-token:${TOKEN}`)).toBe(true);
    expect(readFileSync(path.join(dir, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(res.json)).not.toContain(TOKEN);
  });

  it('rejects duplicates, paths outside the root, and mutations by viewers', async () => {
    expect((await call('POST', '/api/projects', { serverId, name: 'again', path: dir, mode: 'existing' })).status).toBe(409);
    expect((await call('POST', '/api/projects', { serverId, name: 'etc', path: '/etc', mode: 'existing' })).status).toBe(403);
    expect((await call('POST', '/api/projects', { serverId, name: 'esc', path: '/tmp/vc-escape-clone', mode: 'clone', cloneUrl: `${fakeUrl}/repo.git` })).status).toBe(403);
    expect(existsSync('/tmp/vc-escape-clone')).toBe(false);
    expect((await call('GET', '/api/projects', undefined, viewer)).status).toBe(200);
    expect((await call('POST', `/api/projects/${id}/commit`, { message: 'x' }, viewer)).status).toBe(403);
    expect((await call('DELETE', `/api/projects/${id}`, { deleteFiles: true }, viewer)).status).toBe(403);
    expect(existsSync(dir)).toBe(true);
  });

  it('shows status, diff, history and branches, and commits changes', async () => {
    expect((await call('GET', `/api/projects/${id}`)).json.git).toEqual({ isRepo: true, branch: 'main', changed: 0 });
    writeFileSync(path.join(dir, 'README.md'), '# demo\nchanged line\n');
    writeFileSync(path.join(dir, 'new.txt'), 'new file\n');
    const status = (await call('GET', `/api/projects/${id}/status`)).json;
    expect(status.files.map((f: any) => f.path).sort()).toEqual(['README.md', 'new.txt']);
    expect((await call('GET', `/api/projects/${id}/diff`)).json.diff).toContain('+changed line');
    expect((await call('GET', '/api/projects')).json.find((p: any) => p.id === id).git.changed).toBe(2);

    expect((await call('POST', `/api/projects/${id}/checkout`, { ref: 'feature/readme', create: true })).status).toBe(200);
    const commit = await call('POST', `/api/projects/${id}/commit`, { message: 'update readme' });
    expect(commit.json.sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await call('POST', `/api/projects/${id}/commit`, { message: 'nothing' })).status).toBe(400);
    expect((await call('GET', `/api/projects/${id}/commits`)).json.map((c: any) => c.subject)).toEqual(['update readme', 'first commit']);
    const branches = (await call('GET', `/api/projects/${id}/branches`)).json;
    expect(branches.find((b: any) => b.current).name).toBe('feature/readme');
    expect(branches.some((b: any) => b.name === 'origin/main' && b.remote)).toBe(true);
    expect((await call('POST', `/api/projects/${id}/checkout`, { ref: '--orphan' })).status).toBe(400);
  });

  it('manages worktrees', async () => {
    const added = await call('POST', `/api/projects/${id}/worktrees`, { branch: 'agent/task' });
    expect(added.status).toBe(200);
    expect(existsSync(path.join(added.json.path, 'README.md'))).toBe(true);
    expect((await call('GET', `/api/projects/${id}/worktrees`)).json.map((w: any) => w.branch)).toEqual(['feature/readme', 'agent/task']);
    expect((await call('DELETE', `/api/projects/${id}/worktrees`, { path: added.json.path })).status).toBe(200);
    expect(existsSync(added.json.path)).toBe(false);
  });

  it('pushes and opens a pull request with the project token', async () => {
    // dumb HTTP is read-only, so point origin at the same bare repository on disk for the push
    git(dir, 'remote', 'set-url', 'origin', path.join(remote, 'repo.git'));
    expect((await call('POST', `/api/projects/${id}/push`, { branch: 'feature/readme' })).status).toBe(200);
    expect(git(path.join(remote, 'repo.git'), 'log', '-1', '--format=%s', 'feature/readme').trim()).toBe('update readme');

    writeFileSync(path.join(dir, 'pr.txt'), 'pr\n');
    await call('POST', `/api/projects/${id}/commit`, { message: 'for the pr' });
    const pr = await call('POST', `/api/projects/${id}/pull-request`, { title: 'Update readme', body: 'details', head: 'feature/readme', base: 'main' });
    expect(pr.status, JSON.stringify(pr.json)).toBe(200);
    expect(pr.json).toEqual({ url: 'https://github.test/acme/demo/pull/7', number: 7 });
    expect(github.pulls.at(-1)).toEqual({ auth: `Bearer ${TOKEN}`, body: { title: 'Update readme', body: 'details', head: 'feature/readme', base: 'main' } });
    expect(git(path.join(remote, 'repo.git'), 'log', '-1', '--format=%s', 'feature/readme').trim()).toBe('for the pr'); // head was pushed first
    expect((await call('POST', `/api/projects/${id}/pull-request`, { title: 't', head: 'main', base: 'main' })).status).toBe(400);
  });

  it('refuses a pull request without a linked repository or credential', async () => {
    const plain = path.join(root, 'plain');
    execFileSync('git', ['init', '-q', '-b', 'main', plain]);
    const p = await call('POST', '/api/projects', { serverId, name: 'plain', path: plain, mode: 'existing' });
    expect(p.status).toBe(200);
    const res = await call('POST', `/api/projects/${p.json.id}/pull-request`, { title: 't', head: 'x', base: 'main' });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/not linked/);
    expect((await call('DELETE', `/api/projects/${p.json.id}`)).status).toBe(200);
    expect(existsSync(plain)).toBe(true); // files kept unless asked
  });

  it('runs a command exactly as typed, as a supervised session', async () => {
    const ok = await call('POST', `/api/projects/${id}/run`, { command: ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)), process.cwd())', 'two words', '$HOME'] });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const done = await until('run completion', async () => {
      const a = (await call('GET', `/api/agents/${ok.json.id}`)).json;
      return ['completed', 'failed'].includes(a.status) ? a : null;
    });
    expect(done.status).toBe('completed');
    const out = (await call('GET', `/api/agents/${ok.json.id}/events`)).json.filter((e: any) => e.event.type === 'output').map((e: any) => e.event.text).join('');
    expect(out.trim()).toBe(`["two words","$HOME"] ${dir}`); // arguments intact, nothing appended, cwd = project

    const bad = await call('POST', `/api/projects/${id}/run`, { command: ['node', '-e', 'process.exit(3)'], name: 'failing build' });
    const failed = await until('failed run', async () => {
      const a = (await call('GET', `/api/agents/${bad.json.id}`)).json;
      return ['completed', 'failed'].includes(a.status) ? a : null;
    });
    expect(failed.status).toBe('failed');
    const result = (await call('GET', `/api/agents/${bad.json.id}/events`)).json.find((e: any) => e.event.type === 'result');
    expect(result.event.summary).toBe('exited with code 3');
  });

  it('deletes the project and, when asked, its files', async () => {
    expect((await call('DELETE', `/api/projects/${id}`, { deleteFiles: true })).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect((await call('GET', `/api/projects/${id}`)).status).toBe(404);
    const actions = (await call('GET', '/api/audit?limit=500')).json.map((a: any) => a.action);
    for (const a of ['project.create', 'project.commit', 'project.checkout', 'project.push', 'project.pull_request', 'project.worktree_add', 'project.run', 'project.delete']) expect(actions, a).toContain(a);
  });
});
