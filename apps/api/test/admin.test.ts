/** User administration, metrics history, managed services, stored secrets and browser uploads. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { schema } from '../src/db';
import { createStack, type Stack } from './harness';

let s: Stack;
let site: Server;
let siteUrl = '';

beforeAll(async () => {
  s = await createStack('admin', { env: { METRIC_SAMPLE_MS: '1000' } });
  site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body><input id="pw" type="password"><input id="file" type="file">
      <button id="go" onclick="document.getElementById('out').textContent = document.getElementById('pw').value.length + ':' + (document.getElementById('file').files[0]||{}).name">Go</button>
      <p id="out"></p></body></html>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  await new Promise((r) => site.close(r));
  await s.cleanup();
});

describe('user administration', () => {
  let userId = '';
  const login = (email: string, password: string) => s.call('POST', '/api/auth/login', { body: { email, password } });

  it('is admin-only', async () => {
    const operator = await s.userWithRole('operator');
    expect((await s.get('/api/users', operator)).status).toBe(403);
    expect((await s.post('/api/users', { email: 'x@test.dev', role: 'admin', password: 'a-long-enough-password' }, operator)).status).toBe(403);
  });

  it('creates users who can sign in with exactly their role', async () => {
    expect((await s.post('/api/users', { email: 'ops@test.dev', role: 'operator', password: 'short' })).status).toBe(400);
    const res = await s.post('/api/users', { email: 'Ops@Test.dev', role: 'operator', password: 'operator-password-1' });
    expect(res.status).toBe(200);
    userId = res.json.id;
    expect(JSON.stringify(res.json)).not.toContain('password');
    expect((await s.post('/api/users', { email: 'ops@test.dev', role: 'viewer', password: 'operator-password-1' })).status).toBe(409);
    const session = (await login('ops@test.dev', 'operator-password-1')).cookie;
    expect((await s.get('/api/auth/me', session)).json).toMatchObject({ email: 'ops@test.dev', role: 'operator' });
    expect((await s.post('/api/servers', { name: 'nope' }, session)).status).toBe(403);
  });

  it('revokes existing sessions when the role or password changes', async () => {
    const session = (await login('ops@test.dev', 'operator-password-1')).cookie;
    expect((await s.call('PATCH', `/api/users/${userId}`, { body: { role: 'viewer' }, cookie: s.admin })).json.role).toBe('viewer');
    expect((await s.get('/api/auth/me', session)).status).toBe(401);
    await s.call('PATCH', `/api/users/${userId}`, { body: { password: 'a-brand-new-password' }, cookie: s.admin });
    expect((await login('ops@test.dev', 'operator-password-1')).status).toBe(401);
    expect((await login('ops@test.dev', 'a-brand-new-password')).status).toBe(200);
  });

  it('never lets the installation lose its last administrator', async () => {
    const me = (await s.get('/api/auth/me')).json;
    expect((await s.call('PATCH', `/api/users/${me.id}`, { body: { role: 'viewer' }, cookie: s.admin })).status).toBe(409);
    expect((await s.call('DELETE', `/api/users/${me.id}`, { cookie: s.admin })).status).toBe(409);
    expect((await s.call('DELETE', `/api/users/${userId}`, { cookie: s.admin })).status).toBe(200);
    expect((await login('ops@test.dev', 'a-brand-new-password')).status).toBe(401);
    const actions = (await s.get('/api/audit?limit=100')).json.map((a: any) => a.action);
    for (const a of ['user.create', 'user.update', 'user.delete']) expect(actions).toContain(a);
  });
});

describe('metrics history', () => {
  it('persists samples and serves them bucketed', async () => {
    await s.until('persisted samples', async () => (await s.built.ctx.db.select().from(schema.metricSamples)).length >= 2, 10_000);
    const res = await s.get(`/api/servers/${s.serverId}/metrics?range=1h`);
    expect(res.status).toBe(200);
    expect(res.json.length).toBeGreaterThanOrEqual(1);
    expect(res.json[0].memTotal).toBeGreaterThan(1024 * 1024);
    expect(typeof res.json[0].cpu).toBe('number');
    expect((await s.get(`/api/servers/${s.serverId}/metrics?range=forever`)).status).toBe(400);
  });
});

describe('managed services', () => {
  it('exposes only what the worker config allows', async () => {
    expect((await s.get(`/api/servers/${s.serverId}/services`)).json).toEqual([]);
    const res = await s.post(`/api/servers/${s.serverId}/services/sshd.service/stop`);
    expect(res.status).toBe(403);
    expect((await s.post(`/api/servers/${s.serverId}/services/bad;name/stop`)).status).toBe(400);
  });
});

describe('browser sessions with stored secrets and uploads', () => {
  it('resolves {{secret:…}} at launch, uploads a file from the root, and never stores or echoes the secret', async () => {
    const secret = 'S3cret-site-password!';
    expect((await s.post('/api/credentials', { kind: 'secret', label: 'site-pw', secret })).status).toBe(200);
    writeFileSync(path.join(s.root, 'report.txt'), 'quarterly numbers');
    const res = await s.post('/api/browser', {
      serverId: s.serverId, mode: 'steps', name: 'login + upload',
      steps: [
        { action: 'goto', url: siteUrl },
        { action: 'fill', selector: '#pw', value: '{{secret:site-pw}}', secret: true },
        { action: 'upload', selector: '#file', path: path.join(s.root, 'report.txt') },
        { action: 'click', selector: '#go' },
        { action: 'extract', selector: '#out' },
      ],
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const done = await s.until('completion', async () => {
      const b = (await s.get(`/api/browser/${res.json.id}`)).json;
      return ['completed', 'failed'].includes(b.status) ? b : null;
    }, 45_000);
    expect(done.status, done.statusDetail).toBe('completed');
    expect(JSON.stringify(done.result)).toContain(`${secret.length}:report.txt`); // the page really received both
    const everything = JSON.stringify([done, (await s.get(`/api/browser/${res.json.id}/events`)).json, await s.built.ctx.db.select().from(schema.browserSessions)]);
    expect(everything).not.toContain(secret);
    expect(everything).toContain('{{secret:site-pw}}');
  });

  it('fails clearly for an unknown secret and refuses uploads from outside the root', async () => {
    const missing = await s.post('/api/browser', { serverId: s.serverId, mode: 'steps', steps: [{ action: 'goto', url: siteUrl }, { action: 'fill', selector: '#pw', value: '{{secret:nope}}' }] });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toContain('nope');
    const res = await s.post('/api/browser', { serverId: s.serverId, mode: 'steps', steps: [{ action: 'goto', url: siteUrl }, { action: 'upload', selector: '#file', path: '/etc/passwd' }] });
    const done = await s.until('failure', async () => {
      const b = (await s.get(`/api/browser/${res.json.id}`)).json;
      return ['completed', 'failed'].includes(b.status) ? b : null;
    }, 45_000);
    expect(done.status).toBe('failed');
  });
});
