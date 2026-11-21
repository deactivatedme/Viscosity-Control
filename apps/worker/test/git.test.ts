/** New git/health/service handlers, exercised directly against real git and a real HTTP server. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from '../src/context';
import { extraHandlers } from '../src/handlers/extra';
import { gitHandlers } from '../src/handlers/git';
import { createPathGuard } from '../src/paths';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'vc-git-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'vc-git-remote-')));
const ctx = { config: { roots: [root], services: ['allowed.service'] }, guard: createPathGuard([root]) } as unknown as Ctx;
const git = gitHandlers(ctx);
const extra = extraHandlers(ctx);
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

let server: Server;
let base = '';
const seenAuth: string[] = [];

beforeAll(async () => {
  // A bare repository served over git's "dumb" HTTP protocol by a plain static file server.
  const src = join(outside, 'src');
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  writeFileSync(join(src, 'README.md'), '# remote\n');
  sh(src, 'add', '-A');
  sh(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  execFileSync('git', ['clone', '-q', '--bare', src, join(outside, 'repo.git')]);
  sh(join(outside, 'repo.git'), 'update-server-info');
  server = createServer((req, res) => {
    if (req.headers.authorization) seenAuth.push(req.headers.authorization);
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/health') return void res.writeHead(204).end();
    if (url.pathname === '/broken') return void res.writeHead(503).end();
    const file = join(outside, decodeURIComponent(url.pathname));
    if (!file.startsWith(outside) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('git handlers', () => {
  const repo = join(root, 'clone');

  it('clones over HTTP, sends the token as a header and never persists it', async () => {
    await git['git.clone']({ url: `${base}/repo.git`, dest: repo, token: 'ghp_secret_token_value' });
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# remote\n');
    expect(seenAuth.some((h) => Buffer.from(h.replace('Basic ', ''), 'base64').toString() === 'x-access-token:ghp_secret_token_value')).toBe(true);
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('ghp_secret');
    expect(sh(repo, 'remote', 'get-url', 'origin')).not.toContain('ghp_secret');
  });

  it('refuses destinations outside the roots, non-empty targets and non-http URLs', async () => {
    await expect(git['git.clone']({ url: `${base}/repo.git`, dest: join(outside, 'x') })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(git['git.clone']({ url: `${base}/repo.git`, dest: repo })).rejects.toMatchObject({ code: 'invalid' });
    await expect(git['git.clone']({ url: 'file:///etc', dest: join(root, 'f') })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('lists branches and history, creates branches and commits', async () => {
    expect(await git['git.log']({ cwd: repo, limit: 30 })).toMatchObject([{ subject: 'first', author: 't' }]);
    await git['git.checkout']({ cwd: repo, ref: 'feature/x', create: true });
    writeFileSync(join(repo, 'new.txt'), 'hello');
    const { sha } = await git['git.commit']({ cwd: repo, message: 'add new.txt' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(git['git.commit']({ cwd: repo, message: 'nothing' })).rejects.toMatchObject({ code: 'invalid' });
    const branches = await git['git.branches']({ cwd: repo });
    expect(branches.find((b) => b.current)).toMatchObject({ name: 'feature/x', remote: false });
    expect(branches.some((b) => b.name === 'origin/main' && b.remote)).toBe(true);
    expect((await git['git.log']({ cwd: repo, limit: 30 })).map((c) => c.subject)).toEqual(['add new.txt', 'first']);
    await git['git.checkout']({ cwd: repo, ref: 'main', create: false });
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
  });

  it('rejects refs that would be parsed as options', async () => {
    await expect(git['git.checkout']({ cwd: repo, ref: '--orphan', create: false })).rejects.toMatchObject({ code: 'invalid' });
    await expect(git['git.log']({ cwd: repo, limit: 5, ref: '--output=/tmp/x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('adds, lists and removes worktrees inside the roots', async () => {
    const { path } = await git['git.worktreeAdd']({ cwd: repo, branch: 'agent/task-1' });
    expect(path.startsWith(root)).toBe(true);
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect((await git['git.worktrees']({ cwd: repo })).map((w) => w.branch)).toEqual(['main', 'agent/task-1']);
    await git['git.worktreeRemove']({ cwd: repo, path });
    expect(existsSync(path)).toBe(false);
  });
});

describe('health checks and services', () => {
  it('reports real HTTP outcomes', async () => {
    expect(await extra['http.check']({ url: `${base}/health`, timeoutMs: 5000 })).toMatchObject({ ok: true, status: 204 });
    expect(await extra['http.check']({ url: `${base}/broken`, timeoutMs: 5000 })).toMatchObject({ ok: false, status: 503 });
    const down = await extra['http.check']({ url: 'http://127.0.0.1:1/', timeoutMs: 2000 });
    expect(down).toMatchObject({ ok: false, status: null });
    expect(down.error).toBeTruthy();
  });

  it('only controls units listed in the worker config', async () => {
    await expect(extra['service.action']({ name: 'sshd.service', action: 'stop' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
