/**
 * End-to-end smoke test of the worker against a minimal in-process control plane:
 * real filesystem, real PTY, real child-process agent, real Chromium.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AgentEventEnvelope,
  BrowserEventEnvelope,
  Frame,
  Metrics,
  SystemInfo,
  type AgentEvent,
  type BrowserEvent,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from '@viscosity/protocol';
import { enroll } from '../src/enroll';
import { startWorker, type Worker } from '../src/worker';

const SERVER_ID = '7b1d1a52-6c7e-4d0e-9a51-0d6f1c2e3a4b';
const SECRET = 'test-secret';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'vc-smoke-')));

const root = tmp();
const dataDir = tmp();
const configPath = join(tmp(), 'nested', 'worker.json');

let control: Server;
let pages: Server;
let worker: Worker;
let socket: WebSocket;
let hello: Extract<Frame, { t: 'hello' }>;
let enrollBody: unknown;
let rejectedAuth = 0;
const events: { topic: string; data: unknown }[] = [];
const pending = new Map<string, (frame: Extract<Frame, { t: 'res' }>) => void>();
let nextId = 0;

async function rpc<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
  const id = String(++nextId);
  const res = await new Promise<Extract<Frame, { t: 'res' }>>((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ t: 'req', id, method, params }));
  });
  if (!res.ok) throw Object.assign(new Error(res.error?.message), { code: res.error?.code });
  return res.result as MethodResult<M>;
}

async function waitFor<T>(find: () => T | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = find();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const agentEvents = (id: string): AgentEventEnvelope[] =>
  events.filter((e) => e.topic === 'agent.event').map((e) => AgentEventEnvelope.parse(e.data)).filter((e) => e.sessionId === id);
const browserEvents = (id: string): BrowserEventEnvelope[] =>
  events.filter((e) => e.topic === 'browser.event').map((e) => BrowserEventEnvelope.parse(e.data)).filter((e) => e.sessionId === id);
const ofType = <E extends { type: string }, T extends E['type']>(list: { event: E }[], type: T): Extract<E, { type: T }>[] =>
  list.map((e) => e.event).filter((e): e is Extract<E, { type: T }> => e.type === type);
const terminal = (list: { event: AgentEvent | BrowserEvent }[]): string | undefined =>
  ofType(list, 'status').map((s) => s.status).find((s) => ['completed', 'failed', 'stopped'].includes(s));

const PAGE = `<!doctype html><title>Form</title>
<img src="http://169.254.169.254/latest/meta-data/x.png" alt="">
<input id="name" name="name"><button id="go" onclick="location.href='/done?name='+encodeURIComponent(document.getElementById('name').value)">Go</button>`;

beforeAll(async () => {
  pages = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/done') res.end(`<!doctype html><title>Done</title><p id="result">Hello ${url.searchParams.get('name')}</p><a class="l" href="/a">A</a><a class="l" href="/b">B</a>`);
    else if (url.pathname === '/missing') res.writeHead(404).end('nope');
    else res.end(PAGE);
  }).listen(0, '127.0.0.1');

  const wss = new WebSocketServer({ noServer: true });
  control = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/worker/enroll') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        enrollBody = JSON.parse(body);
        res.setHeader('content-type', 'application/json').end(JSON.stringify({ serverId: SERVER_ID, secret: SECRET }));
      });
    } else res.writeHead(404).end();
  });
  control.on('upgrade', (req, sock, head) => {
    if (req.url !== '/ws/worker' || req.headers.authorization !== `Bearer ${SERVER_ID}.${SECRET}` || req.headers['x-viscosity-protocol'] !== '1') {
      rejectedAuth++;
      sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        const frame = Frame.parse(JSON.parse(raw.toString()));
        if (frame.t === 'hello') hello = frame;
        else if (frame.t === 'res') pending.get(frame.id)?.(frame);
        else if (frame.t === 'evt') events.push({ topic: frame.topic, data: frame.data });
      });
    });
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));

  process.env.WORKER_PRIVATE = 'must-not-leak';
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  const config = await enroll({ url: `${controlUrl}/`, token: 'x'.repeat(32), configPath, roots: [root], dataDir });
  worker = await startWorker({
    ...config,
    allowRootShell: true,
    metricsIntervalMs: 300,
    browser: { allowHosts: [`127.0.0.1:${(pages.address() as AddressInfo).port}`] },
  });
  await waitFor(() => hello, 'hello frame');
}, 30_000);

afterAll(async () => {
  await worker?.stop();
  control?.close();
  pages?.close();
});

describe('worker smoke', () => {
  it('enrolls, writes a 0600 config and says hello', () => {
    expect(enrollBody).toMatchObject({ token: 'x'.repeat(32), protocol: 1 });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ serverId: SERVER_ID, secret: SECRET, roots: [root] });
    expect(hello.protocol).toBe(1);
    expect(hello.system.roots).toEqual([root]);
    expect(hello.system.capabilities).toMatchObject({ pty: true, git: true, browser: true, claude: true, codex: true, reboot: false });
    expect(rejectedAuth).toBe(0);
  });

  it('answers system.info and streams real metrics', async () => {
    const info = SystemInfo.parse(await rpc('system.info', {}));
    expect(info.cpuCores).toBeGreaterThan(0);
    expect(info.memTotal).toBeGreaterThan(0);
    await waitFor(() => events.filter((e) => e.topic === 'metrics').length >= 2, 'two metrics samples');
    const m = Metrics.parse(events.filter((e) => e.topic === 'metrics').at(-1)!.data);
    expect(m.memTotal).toBeGreaterThan(m.memAvailable);
    expect(m.diskTotal).toBeGreaterThan(0);
    expect(m.processes).toBeGreaterThan(1);
    expect(m.cpu).toBeGreaterThanOrEqual(0);
    expect(m.cpu).toBeLessThanOrEqual(100);
  });

  it('rejects unknown methods, bad params and disabled operations with the right codes', async () => {
    await expect(rpc('nope.method' as MethodName, {} as never)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(rpc('fs.list', { path: 42 } as never)).rejects.toMatchObject({ code: 'invalid' });
    await expect(rpc('system.reboot', {})).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc('process.kill', { pid: 1 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does chunked file IO inside the root and refuses everything outside it', async () => {
    const file = join(root, 'dir', 'hello.txt');
    await rpc('fs.mkdir', { path: join(root, 'dir') });
    await rpc('fs.write', { path: file, data: Buffer.from('hello ').toString('base64') });
    await rpc('fs.write', { path: file, data: Buffer.from('world').toString('base64'), offset: 6 });
    const head = await rpc('fs.read', { path: file, length: 5 });
    expect(Buffer.from(head.data, 'base64').toString()).toBe('hello');
    expect(head).toMatchObject({ size: 11, eof: false });
    const tail = await rpc('fs.read', { path: file, offset: 5 });
    expect(Buffer.from(tail.data, 'base64').toString()).toBe(' world');
    expect(tail.eof).toBe(true);
    expect((await rpc('fs.list', { path: join(root, 'dir') })).map((e) => e.name)).toEqual(['hello.txt']);
    expect(await rpc('fs.stat', { path: file })).toMatchObject({ type: 'file', size: 11, mode: expect.stringMatching(/^[rwx-]{9}$/) });
    await rpc('fs.rename', { from: file, to: join(root, 'dir', 'renamed.txt') });
    expect((await rpc('fs.search', { path: root, query: 'RENAMED' })).map((e) => e.name)).toEqual(['renamed.txt']);
    await expect(rpc('fs.delete', { path: join(root, 'dir') })).rejects.toMatchObject({ code: 'failed' }); // not empty, not recursive
    await rpc('fs.delete', { path: join(root, 'dir'), recursive: true });
    await expect(rpc('fs.stat', { path: file })).rejects.toMatchObject({ code: 'not_found' });

    await expect(rpc('fs.read', { path: '/etc/passwd' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc('fs.write', { path: join(root, '..', 'escape.txt'), data: '' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc('fs.list', { path: '/' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc('fs.delete', { path: root, recursive: true })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc('pty.open', { id: uuid(99), cols: 80, rows: 24, cwd: '/etc' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lists processes and reports docker honestly', async () => {
    expect((await rpc('process.list', {})).some((p) => p.pid === process.pid)).toBe(true);
    if (!hello.system.capabilities.docker) await expect(rpc('docker.list', {})).rejects.toMatchObject({ code: 'unsupported' });
    else expect(Array.isArray(await rpc('docker.list', {}))).toBe(true);
  });

  it('runs an interactive PTY that survives re-attach', async () => {
    const id = uuid(1);
    const opened = await rpc('pty.open', { id, cols: 100, rows: 30 });
    expect(opened.pid).toBeGreaterThan(0);
    const output = (): string =>
      events.filter((e) => e.topic === 'pty.data' && (e.data as { id: string }).id === id).map((e) => Buffer.from((e.data as { data: string }).data, 'base64').toString()).join('');
    const send = (text: string): void => socket.send(JSON.stringify({ t: 'evt', topic: 'pty.input', data: { id, data: Buffer.from(text).toString('base64') } }));
    socket.send(JSON.stringify({ t: 'evt', topic: 'pty.resize', data: { id, cols: 120, rows: 40 } }));
    send('echo hi-$((40+2)) cols=$(tput cols 2>/dev/null || stty size | cut -d" " -f2)\n');
    await waitFor(() => output().includes('hi-42 cols=120'), 'echoed shell output with resized width');
    const attached = await rpc('pty.attach', { id });
    expect(attached.alive).toBe(true);
    expect(Buffer.from(attached.scrollback, 'base64').toString()).toContain('hi-42');
    expect(await rpc('pty.list', {})).toContainEqual({ id, alive: true });
    send('exit 3\n');
    const exit = await waitFor(() => events.find((e) => e.topic === 'pty.exit' && (e.data as { id: string }).id === id), 'pty exit');
    expect(exit.data).toMatchObject({ exitCode: 3 });
    expect((await rpc('pty.attach', { id })).alive).toBe(false);
    await expect(rpc('pty.attach', { id: uuid(2) })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports git status and diffs', async () => {
    expect(await rpc('git.status', { cwd: root })).toEqual({ isRepo: false, branch: null, files: [] });
    const repo = join(root, 'repo');
    await rpc('fs.mkdir', { path: repo });
    const git = (...args: string[]): void => void execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'new file.txt'), 'x');
    expect(await rpc('git.status', { cwd: repo })).toEqual({ isRepo: true, branch: 'main', files: [{ path: 'a.txt', status: 'M' }, { path: 'new file.txt', status: '??' }] });
    const { diff, truncated } = await rpc('git.diff', { cwd: repo, path: 'a.txt' });
    expect(diff).toContain('-one\n+two');
    expect(truncated).toBe(false);
  });

  it('supervises a custom agent: ordered durable events, env isolation, worktree, replay, follow-up', async () => {
    const id = uuid(10);
    const script = 'console.log(`out:${process.argv.at(-1)} cwd:${process.cwd()} private:${process.env.WORKER_PRIVATE ?? "unset"} cred:${process.env.MY_KEY?.length}`); console.error("warn")';
    const start = { sessionId: id, provider: 'custom' as const, cwd: join(root, 'repo'), permissionMode: 'auto' as const, command: ['node', '-e', script], env: { MY_KEY: 's3cr3t-value' }, worktreeBranch: 'agent/one' };
    await rpc('agent.start', { ...start, prompt: 'hello' });
    await waitFor(() => terminal(agentEvents(id)), 'agent to finish');
    const first = agentEvents(id);
    expect(first.map((e) => e.seq)).toEqual(first.map((_, i) => i + 1));
    expect(first[0]!.event).toEqual({ type: 'user', text: 'hello' });
    expect(ofType(first, 'status').map((s) => s.status)).toEqual(['starting', 'running', 'completed']);
    const worktree = join(root, '.viscosity-worktrees', id);
    const stdout = ofType(first, 'output').filter((o) => o.stream === 'stdout').map((o) => o.text).join('');
    expect(stdout).toContain(`out:hello cwd:${worktree} private:unset cred:12`);
    expect(ofType(first, 'output').some((o) => o.stream === 'stderr' && o.text.includes('warn'))).toBe(true);
    expect(ofType(first, 'result')[0]).toMatchObject({ ok: true, summary: 'exited with code 0', worktree });
    expect(execFileSync('git', ['-C', worktree, 'branch', '--show-current']).toString().trim()).toBe('agent/one');
    expect(readFileSync(join(dataDir, 'agents', `${id}.jsonl`), 'utf8')).not.toContain('s3cr3t-value');

    // Replay re-emits exactly the events after the given seq.
    const before = events.length;
    expect(await rpc('agent.replay', { sessionId: id, afterSeq: 2 })).toEqual({ count: first.length - 2 });
    await waitFor(() => events.length >= before + first.length - 2, 'replayed events');
    expect(events.slice(before).map((e) => AgentEventEnvelope.parse(e.data).seq)).toEqual(first.slice(2).map((e) => e.seq));
    events.splice(before);

    // A follow-up run on the same session continues the sequence and reuses the worktree.
    await rpc('agent.start', { ...start, prompt: 'again' });
    await waitFor(() => ofType(agentEvents(id), 'status').filter((s) => s.status === 'completed').length === 2, 'follow-up to finish');
    const all = agentEvents(id);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all[first.length]!.event).toEqual({ type: 'user', text: 'again' });

    await expect(rpc('agent.start', { ...start, sessionId: uuid(11), cwd: '/etc', prompt: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rpc('agent.start', { ...start, sessionId: uuid(11), command: undefined, prompt: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports failures, stops and timeouts truthfully', async () => {
    const base = { provider: 'custom' as const, cwd: root, permissionMode: 'auto' as const, prompt: 'x' };
    await rpc('agent.start', { ...base, sessionId: uuid(20), command: ['node', '-e', 'process.exit(7)'] });
    await rpc('agent.start', { ...base, sessionId: uuid(21), command: ['/nonexistent/agent-binary'] });
    await rpc('agent.start', { ...base, sessionId: uuid(22), command: ['node', '-e', 'setInterval(()=>{},1000)'] });
    await rpc('agent.start', { ...base, sessionId: uuid(23), command: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 600 });
    await expect(rpc('agent.start', { ...base, sessionId: uuid(22), command: ['true'] })).rejects.toMatchObject({ code: 'invalid' }); // already running

    await waitFor(() => ofType(agentEvents(uuid(22)), 'status').some((s) => s.status === 'running'), 'long agent running');
    await rpc('agent.stop', { sessionId: uuid(22) });

    for (const n of [20, 21, 22, 23]) await waitFor(() => terminal(agentEvents(uuid(n))), `agent ${n} to end`);
    expect(terminal(agentEvents(uuid(20)))).toBe('failed');
    expect(ofType(agentEvents(uuid(20)), 'result')[0]).toMatchObject({ ok: false, summary: 'exited with code 7' });
    expect(terminal(agentEvents(uuid(21)))).toBe('failed');
    expect(ofType(agentEvents(uuid(21)), 'error')[0]!.message).toContain('ENOENT');
    expect(terminal(agentEvents(uuid(22)))).toBe('stopped');
    expect(terminal(agentEvents(uuid(23)))).toBe('failed');
    expect(ofType(agentEvents(uuid(23)), 'error')[0]!.message).toMatch(/Timed out/);
    await expect(rpc('agent.stop', { sessionId: uuid(20) })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('runs a scripted browser task with verification, screenshots, approval and subresource blocking', async () => {
    const id = uuid(30);
    const base = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    await rpc('browser.start', {
      sessionId: id,
      mode: 'steps',
      startUrl: `${base}/`,
      steps: [
        { action: 'fill', selector: '#name', value: 'Ada' },
        { action: 'approval', reason: 'submit the form' },
        { action: 'click', selector: '#go' },
        { action: 'waitFor', selector: '#result' },
        { action: 'extract', selector: '#result' },
        { action: 'extract', selector: 'a.l', attribute: 'href' },
      ],
    });
    const request = await waitFor(() => ofType(browserEvents(id), 'approval_request')[0], 'approval request', 40_000);
    expect(request.reason).toBe('submit the form');
    expect(ofType(browserEvents(id), 'status').at(-1)!.status).toBe('waiting_approval');
    await expect(rpc('browser.approve', { sessionId: id, approvalId: 'wrong', decision: 'allow' })).rejects.toMatchObject({ code: 'not_found' });
    await rpc('browser.approve', { sessionId: id, approvalId: request.approvalId, decision: 'allow' });
    await waitFor(() => terminal(browserEvents(id)), 'browser session to finish', 40_000);

    const all = browserEvents(id);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(terminal(all)).toBe('completed');
    const actions = ofType(all, 'action');
    expect(actions.map((a) => [a.action, a.ok])).toEqual([['goto', true], ['fill', true], ['click', true], ['waitFor', true], ['extract', true], ['extract', true]]);
    expect(actions[0]!.verified).toContain('HTTP 200');
    expect(actions[1]).toMatchObject({ detail: '#name (3 chars)', verified: expect.stringContaining('read back and matches') });
    expect(actions[2]).toMatchObject({ url: `${base}/done?name=Ada`, title: 'Done', verified: expect.stringContaining('/done?name=Ada') });
    const shots = ofType(all, 'screenshot');
    expect(shots.length).toBe(3); // goto, fill, click
    expect(Buffer.from(shots[0]!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic
    expect(ofType(all, 'blocked')).toEqual([{ type: 'blocked', url: 'http://169.254.169.254/latest/meta-data/x.png', reason: expect.stringContaining('private') }]);
    expect(ofType(all, 'result')[0]).toEqual({
      type: 'result',
      ok: true,
      summary: '7 step(s) completed and verified',
      data: { extracted: [{ selector: '#result', values: ['Hello Ada'] }, { selector: 'a.l', values: ['/a', '/b'] }] },
    });
    expect(await rpc('browser.replay', { sessionId: id, afterSeq: all.length - 1 })).toEqual({ count: 1 });
  }, 90_000);

  it('blocks private destinations, reports HTTP errors, denied approvals and stops', async () => {
    const base = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}/`; // loopback, not in allowHosts
    await rpc('browser.start', { sessionId: uuid(31), mode: 'steps', startUrl: controlUrl });
    await rpc('browser.start', { sessionId: uuid(32), mode: 'steps', startUrl: `${base}/missing` });
    await rpc('browser.start', { sessionId: uuid(33), mode: 'steps', startUrl: `${base}/`, steps: [{ action: 'approval', reason: 'pay' }, { action: 'click', selector: '#go' }] });
    await rpc('browser.start', { sessionId: uuid(34), mode: 'steps', startUrl: `${base}/`, steps: [{ action: 'fill', selector: '#does-not-exist', value: 'x' }] });
    await expect(rpc('browser.start', { sessionId: uuid(35), mode: 'agent', task: 'x' })).rejects.toMatchObject({ code: 'invalid' });

    const deny = await waitFor(() => ofType(browserEvents(uuid(33)), 'approval_request')[0], 'approval request', 40_000);
    await rpc('browser.approve', { sessionId: uuid(33), approvalId: deny.approvalId, decision: 'deny' });
    await rpc('browser.stop', { sessionId: uuid(34) }); // stopped while waiting for a selector that never appears

    for (const n of [31, 32, 33, 34]) await waitFor(() => terminal(browserEvents(uuid(n))), `browser ${n} to end`, 40_000);
    const blocked = ofType(browserEvents(uuid(31)), 'action')[0]!;
    expect(blocked).toMatchObject({ action: 'goto', ok: false, error: expect.stringMatching(/blocked: .*private/) });
    expect(terminal(browserEvents(uuid(31)))).toBe('failed');
    expect(ofType(browserEvents(uuid(32)), 'action')[0]).toMatchObject({ ok: false, error: 'server answered HTTP 404' });
    expect(ofType(browserEvents(uuid(33)), 'result')[0]).toMatchObject({ ok: false, summary: expect.stringContaining('denied') });
    expect(ofType(browserEvents(uuid(33)), 'action').map((a) => a.action)).toEqual(['goto']); // the click never ran
    expect(terminal(browserEvents(uuid(34)))).toBe('stopped');
  }, 90_000);

  it('reconnects after the control plane drops the socket and reports known sessions', async () => {
    const previous = socket;
    const firstHello = hello;
    previous.terminate();
    await waitFor(() => socket !== previous && hello !== firstHello, 'reconnect + new hello', 15_000);
    expect(hello.agents).toContainEqual({ id: uuid(10), lastSeq: agentEvents(uuid(10)).length, active: false });
    expect(hello.browsers.map((b) => b.id)).toContain(uuid(30));
    expect((await rpc('system.info', {})).hostname).toBe(hello.system.hostname);
  }, 30_000);
});
