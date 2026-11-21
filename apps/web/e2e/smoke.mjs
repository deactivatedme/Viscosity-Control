#!/usr/bin/env node
/**
 * End-to-end acceptance run through the real UI, on a throwaway stack:
 * fresh database → API → production build of the dashboard (served the same way the
 * Docker image serves it) → a real worker enrolled with the token shown in the UI.
 *
 *   pnpm test:e2e            (needs local Postgres + Chromium; see docs/DEPLOYMENT.md)
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const repo = path.resolve(import.meta.dirname, '../../..');
const ADMIN_DB = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://viscosity:viscosity@127.0.0.1:5432/postgres';
const DB = `viscosity_e2e_${process.pid}`;
const API = 4100, WEB = 3100;
const ORIGIN = `http://localhost:${WEB}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'vc-e2e-'));
const root = path.join(tmp, 'root');
const procs = [];
const results = [];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString();
function start(name, cmd, args, env = {}, cwd = repo) {
  // own process group, so teardown also reaches the children of `pnpm exec`
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  procs.push({ name, child, log: () => log });
  return child;
}
function killTree(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}
async function waitFor(url, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(`  ✓ ${name} (${Date.now() - t} ms)`); }
  catch (err) { results.push(`  ✗ ${name}\n      ${String(err.message ?? err).split('\n')[0]}`); throw err; }
}

let failed = false;
try {
  for (const port of [API, WEB]) {
    const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} is already in use; stop whatever is listening there and retry`);
  }
  sh('psql', [ADMIN_DB, '-qc', `create database ${DB}`]);
  sh('mkdir', ['-p', root]);

  const dbUrl = ADMIN_DB.replace(/\/[^/]+$/, `/${DB}`);
  start('api', 'pnpm', ['--filter', '@viscosity/api', 'exec', 'tsx', 'src/index.ts'], {
    DATABASE_URL: dbUrl, VISCOSITY_SECRET_KEY: 'e2e-secret-key-0123456789abcdef-0123', PUBLIC_ORIGIN: ORIGIN, WORKER_URL: `http://localhost:${API}`,
    PORT: String(API), DATA_DIR: path.join(tmp, 'data'), LOG_LEVEL: 'warn',
  });

  console.log('building the dashboard (production)…');
  sh('pnpm', ['--filter', '@viscosity/web', 'build'], { env: { ...process.env, API_URL: `http://127.0.0.1:${API}`, NEXT_PUBLIC_WS_ORIGIN: `ws://localhost:${API}`, NEXT_TELEMETRY_DISABLED: '1' } });
  const standalone = path.join(repo, 'apps/web/.next/standalone');
  cpSync(path.join(repo, 'apps/web/.next/static'), path.join(standalone, 'apps/web/.next/static'), { recursive: true });
  cpSync(path.join(repo, 'apps/web/public'), path.join(standalone, 'apps/web/public'), { recursive: true });
  start('web', 'node', ['apps/web/server.js'], { PORT: String(WEB), HOSTNAME: 'localhost' }, standalone);
  await waitFor(`http://127.0.0.1:${API}/api/health`);
  await waitFor(`${ORIGIN}/login`);

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const nav = (name) => page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name, exact: true }).click();
  let worker;

  await step('first run creates the administrator and signs in', async () => {
    await page.goto(ORIGIN);
    await page.waitForURL(/\/setup/);
    await page.getByLabel('Administrator email').fill('admin@e2e.test');
    await page.getByLabel('Password', { exact: false }).first().fill('e2e-password-123456');
    await page.getByLabel('Confirm password').fill('e2e-password-123456');
    await page.getByRole('button', { name: 'Create administrator' }).click();
    await page.getByRole('navigation', { name: 'Primary' }).waitFor({ timeout: 30_000 });
    await page.getByText('Getting started').waitFor();
  });

  await step('a server is enrolled with the single-use command from the UI', async () => {
    await nav('Servers');
    await page.getByText('No servers yet').waitFor();
    await page.getByRole('button', { name: 'Add server' }).first().click();
    await page.getByLabel('Name').fill('e2e-box');
    await page.getByRole('button', { name: 'Create and get install command' }).click();
    const command = await page.locator('pre').first().innerText();
    const token = /--token (\S+)/.exec(command)?.[1];
    if (!token) throw new Error('no token in the install command');
    await page.getByText('Waiting for the worker to connect').waitFor();
    const cfg = path.join(tmp, 'worker.json');
    sh('pnpm', ['--filter', '@viscosity/worker', 'exec', 'tsx', 'src/index.ts', 'enroll', '--url', `http://localhost:${API}`, '--token', token, '--config', cfg, '--root', root, '--data-dir', path.join(tmp, 'wdata')]);
    // the e2e machine may run as root; a real install uses the unprivileged service account
    sh('node', ['-e', `const fs=require('fs');const c=JSON.parse(fs.readFileSync('${cfg}'));c.allowRootShell=true;fs.writeFileSync('${cfg}',JSON.stringify(c))`]);
    worker = start('worker', 'pnpm', ['--filter', '@viscosity/worker', 'exec', 'tsx', 'src/index.ts', 'run', '--config', cfg]);
    await page.getByText('Connected — receiving live metrics').waitFor({ timeout: 30_000 });
  });

  await step('real metrics and processes are shown for the server', async () => {
    await page.getByRole('button', { name: 'Open server' }).click();
    await page.getByText('load ', { exact: false }).first().waitFor({ timeout: 20_000 });
    await page.getByRole('columnheader', { name: 'PID' }).waitFor();
    if ((await page.locator('tbody tr:visible').count()) < 5) throw new Error('expected a real process list');
  });

  await step('an interactive terminal works', async () => {
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click();
    await page.locator('.xterm:visible').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await page.locator('.xterm:visible').first().click();
    await page.keyboard.type('echo vc-$((6*7))\n');
    await page.locator('.xterm-rows:visible', { hasText: 'vc-42' }).waitFor({ timeout: 15_000 });
  });

  await step('an agent runs on the server and streams its output', async () => {
    await nav('Agents');
    await page.getByRole('button', { name: 'New agent' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Custom', { exact: true }).first().click();
    await dialog.getByLabel('Working directory').fill(root);
    await dialog.getByLabel('Command').fill(['node', '-e', 'let n=0;const t=setInterval(()=>{console.log("tick "+(++n));if(n===5){clearInterval(t);console.log("all done")}},200)'].join('\n'));
    await dialog.getByRole('textbox', { name: 'Task' }).fill('e2e streaming task');
    await dialog.getByRole('button', { name: /start|launch|create/i }).last().click();
    const out = page.getByLabel('Agent output');
    await out.getByText('tick 1').waitFor({ timeout: 20_000 });
    await out.getByText('all done').waitFor({ timeout: 20_000 });
    // other tabs stay mounted while hidden, so scope to what is actually on screen
    await page.locator('span:visible', { hasText: /^Completed$/ }).first().waitFor({ timeout: 15_000 });
  });

  await step('agent history survives a page refresh', async () => {
    await page.reload();
    const out = page.getByLabel('Agent output');
    await out.getByText('all done').waitFor({ timeout: 30_000 });
    await out.getByText('tick 3').waitFor();
  });

  await step('a disconnected worker is shown as offline', async () => {
    killTree(worker);
    await nav('Servers');
    await page.locator('tbody tr:visible', { hasText: 'e2e-box' }).getByText('Offline').waitFor({ timeout: 45_000 });
  });

  await step('no uncaught page errors', async () => { if (pageErrors.length) throw new Error(pageErrors.join(' | ')); });
  await browser.close();
} catch (err) {
  failed = true;
  console.error(err);
  for (const p of procs) console.error(`--- ${p.name} log (tail) ---\n${p.log().slice(-1500)}`);
} finally {
  for (const p of procs) killTree(p.child);
  try { sh('psql', [ADMIN_DB, '-qc', `drop database if exists ${DB} with (force)`]); } catch (e) { console.error('could not drop', DB, e.message); }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nVISCOSITY CONTROL e2e\n${results.join('\n')}\n${failed ? 'FAILED' : 'PASSED'}`);
  process.exit(failed ? 1 : 0);
}
