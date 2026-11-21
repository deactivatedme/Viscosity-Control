import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { RpcError, type BrowserEvent, type BrowserStartParams } from '@viscosity/protocol';
import { OK, type Ctx, type Handlers } from '../context';
import { EventLog } from '../eventlog';
import { errMessage, log } from '../log';
import { Sessions, type AbortReason, type Run } from '../sessions';
import { perform, type ActionOutcome } from './actions';
import { createNetworkGuard, type NetworkGuard } from './guard';
import { runLlm } from './llm';

export interface RunOutcome {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** What a browsing strategy (scripted steps or the LLM loop) needs from the session. */
export interface BrowserRun {
  /** The most recently opened page (follows popups/new tabs). */
  page(): Page;
  signal: AbortSignal;
  check: NetworkGuard;
  emit(event: BrowserEvent): void;
  /** Emits the action event and, when the page may have changed, a screenshot. */
  reportAction(action: string, outcome: ActionOutcome): Promise<void>;
  screenshot(): Promise<void>;
  requestApproval(reason: string): Promise<'allow' | 'deny'>;
}

async function runSteps(run: BrowserRun, params: BrowserStartParams): Promise<RunOutcome> {
  const steps = [...(params.startUrl ? [{ action: 'goto' as const, url: params.startUrl }] : []), ...(params.steps ?? [])].slice(0, params.maxSteps);
  const extracted: { selector: string; values: string[] }[] = [];
  for (const [i, step] of steps.entries()) {
    if (run.signal.aborted) throw new Error('aborted');
    if (step.action === 'approval') {
      if ((await run.requestApproval(step.reason)) === 'deny') return { ok: false, summary: `Stopped at step ${i + 1}: the operator denied "${step.reason}"`, data: { extracted } };
    } else if (step.action === 'screenshot') {
      await run.screenshot();
    } else {
      const outcome = await perform(run.page(), step, run.check);
      await run.reportAction(step.action, outcome);
      if (!outcome.ok) return { ok: false, summary: `Step ${i + 1} (${step.action} ${outcome.detail}) failed: ${outcome.error}`, data: { extracted } };
      if (step.action === 'extract') extracted.push({ selector: step.selector, values: outcome.data ?? [] });
    }
  }
  return { ok: true, summary: `${steps.length} step(s) completed and verified`, data: { extracted } };
}

export interface BrowserManager {
  handlers: Pick<Handlers, 'browser.start' | 'browser.stop' | 'browser.approve' | 'browser.replay'>;
  sessions: Sessions<BrowserEvent>;
}

export function createBrowserManager(ctx: Ctx): BrowserManager {
  const root = join(ctx.config.dataDir, 'browser');
  const sessions = new Sessions<BrowserEvent>(new EventLog(root), (envelope) => ctx.emit('browser.event', envelope));

  async function execute(params: BrowserStartParams, run: Run): Promise<void> {
    const id = params.sessionId;
    const emit = (event: BrowserEvent): void => sessions.emit(id, event);
    let browser: Browser | null = null;
    emit({ type: 'status', status: 'starting' });
    try {
      const { chromium } = await import('playwright');
      const downloads = join(root, id);
      await mkdir(downloads, { recursive: true });
      // A dedicated browser process and ephemeral context per session: no shared cookies, cache or profile.
      browser = await chromium.launch({
        headless: true,
        downloadsPath: downloads,
        proxy: ctx.config.browser?.proxy ? { server: ctx.config.browser.proxy } : undefined,
      });
      // Closing the browser is what makes in-flight Playwright calls reject on stop/timeout.
      run.signal.addEventListener('abort', () => void browser?.close().catch(() => undefined), { once: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
      context.setDefaultTimeout(15_000);

      const check = createNetworkGuard(ctx.config.browser?.allowHosts);
      const reported = new Set<string>();
      const block = (url: string, reason: string): void => {
        if (reported.has(url)) return;
        reported.add(url);
        emit({ type: 'blocked', url, reason });
      };
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        const reason = await check(url);
        if (reason) block(url, reason);
        // The request may already be gone if its page closed; nothing to do then.
        await (reason ? route.abort('blockedbyclient') : route.continue()).catch(() => undefined);
      });
      await context.routeWebSocket(/.*/, async (ws) => {
        const reason = await check(ws.url());
        if (!reason) return void ws.connectToServer();
        block(ws.url(), reason);
        await ws.close({ code: 1008, reason: 'blocked by policy' });
      });

      let page = await context.newPage();
      const watch = (p: Page): void => {
        p.on('download', (download) => {
          const file = join(downloads, basename(download.suggestedFilename()) || 'download');
          download.saveAs(file).then(
            () => emit({ type: 'action', action: 'download', detail: basename(file), ok: true, verified: 'saved to the session download directory', url: p.url(), title: '' }),
            (err: unknown) => emit({ type: 'action', action: 'download', detail: basename(file), ok: false, error: errMessage(err), url: p.url(), title: '' }),
          );
        });
      };
      watch(page);
      context.on('page', (p) => {
        page = p;
        watch(p);
      });

      const screenshot = async (): Promise<void> => {
        const data = await page.screenshot({ type: 'jpeg', quality: 60 });
        emit({ type: 'screenshot', data: data.toString('base64'), url: page.url() });
      };
      const session: BrowserRun = {
        page: () => page,
        signal: run.signal,
        // Navigations refused up front are reported on the timeline just like blocked sub-requests.
        check: async (url) => {
          const reason = await check(url);
          if (reason) block(url, reason);
          return reason;
        },
        emit,
        screenshot,
        reportAction: async (action, o) => {
          emit({ type: 'action', action, detail: o.detail, ok: o.ok, verified: o.verified, error: o.error, url: page.url(), title: await page.title() });
          if (o.changed) await screenshot();
        },
        requestApproval: async (reason) => {
          const approvalId = randomUUID();
          emit({ type: 'approval_request', approvalId, reason });
          emit({ type: 'status', status: 'waiting_approval' });
          const { decision } = await run.waitApproval(approvalId);
          emit({ type: 'approval_resolved', approvalId, decision });
          emit({ type: 'status', status: 'running' });
          return decision;
        },
      };

      emit({ type: 'status', status: 'running' });
      const outcome = params.mode === 'steps' ? await runSteps(session, params) : await runLlm(session, params);
      if (run.signal.aborted) throw new Error('aborted');
      emit({ type: 'result', ...outcome });
      emit({ type: 'status', status: outcome.ok ? 'completed' : 'failed' });
    } catch (err) {
      const reason = run.signal.aborted ? (run.signal.reason as AbortReason) : null;
      if (reason === 'stopped') {
        emit({ type: 'result', ok: false, summary: 'Stopped by the operator' });
        emit({ type: 'status', status: 'stopped' });
      } else {
        const message = reason === 'timeout' ? `Timed out after ${Math.round(params.timeoutMs / 1000)}s` : errMessage(err);
        log('warn', 'browser session failed', { sessionId: id, error: message });
        emit({ type: 'error', message });
        emit({ type: 'result', ok: false, summary: message });
        emit({ type: 'status', status: 'failed' });
      }
    } finally {
      await browser?.close().catch((err: unknown) => log('warn', 'failed to close browser', { sessionId: id, error: errMessage(err) }));
      sessions.end(id);
    }
  }

  return {
    sessions,
    handlers: {
      'browser.start': async (params) => {
        if (sessions.isActive(params.sessionId)) throw new RpcError('invalid', 'session is already running');
        if (params.mode === 'steps' && !params.startUrl && !params.steps?.length) throw new RpcError('invalid', 'steps mode needs a startUrl or at least one step');
        if (params.mode === 'agent' && (!params.task || !params.llm?.apiKey)) throw new RpcError('invalid', 'agent mode needs a task and an LLM credential');
        void execute(params, sessions.begin(params.sessionId, params.timeoutMs));
        return OK;
      },
      'browser.stop': async ({ sessionId }) => {
        sessions.stop(sessionId);
        return OK;
      },
      'browser.approve': async ({ sessionId, approvalId, decision }) => {
        sessions.approve(sessionId, approvalId, { decision });
        return OK;
      },
      'browser.replay': ({ sessionId, afterSeq }) => sessions.replay(sessionId, afterSeq),
    },
  };
}
