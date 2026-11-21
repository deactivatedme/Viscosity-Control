import type { Page } from 'playwright';
import type { BrowserStep } from '@viscosity/protocol';
import { errMessage } from '../log';
import type { NetworkGuard } from './guard';

/** Resolves a path inside the worker's allowed roots, or throws. */
export type PathGuard = (path: string) => Promise<string>;
export type Action = Exclude<BrowserStep, { action: 'approval' } | { action: 'screenshot' }>;

export interface ActionOutcome {
  ok: boolean;
  /** What was attempted (never contains typed values). */
  detail: string;
  /** What was observed afterwards that confirms the effect. */
  verified?: string;
  error?: string;
  /** Extracted values, for `extract`. */
  data?: string[];
  /** Whether the page may look different now (worth a screenshot). */
  changed: boolean;
}

/** Wait for a navigation the action may have triggered; no navigation means this returns at once. */
async function settle(page: Page): Promise<string> {
  const timedOut = await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).then(
    () => false,
    () => true,
  );
  return `now at ${page.url()} — "${await page.title()}"${timedOut ? ' (page still loading after 10s)' : ''}`;
}

async function run(page: Page, action: Action, check: NetworkGuard, guardPath: PathGuard): Promise<Omit<ActionOutcome, 'ok' | 'detail' | 'changed'>> {
  switch (action.action) {
    case 'goto': {
      const reason = await check(action.url);
      if (reason) throw new Error(`blocked: ${reason}`);
      const attempt = () => page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // One retry covers transient DNS/connection resets; a second failure is reported as-is.
      const response = await attempt().catch(async (err: unknown) => {
        if (errMessage(err).includes('ERR_BLOCKED_BY_CLIENT')) throw err;
        await page.waitForTimeout(1000);
        return attempt();
      });
      const status = response?.status() ?? 0;
      const verified = `HTTP ${status || 'n/a'}, landed on ${page.url()}`;
      if (status >= 400) return { verified, error: `server answered HTTP ${status}` };
      return { verified };
    }
    case 'click':
      await page.locator(action.selector).first().click();
      return { verified: await settle(page) };
    case 'fill': {
      const field = page.locator(action.selector).first();
      await field.fill(action.value);
      const actual = await field.inputValue();
      if (actual !== action.value) return { error: `read-back mismatch: field holds ${actual.length} chars, expected ${action.value.length}` };
      return { verified: `field value read back and matches (${actual.length} chars)` };
    }
    case 'upload': {
      // Only files inside the worker's allowed roots may leave the machine through a browser.
      const file = await guardPath(action.path);
      const input = page.locator(action.selector).first();
      await input.setInputFiles(file);
      const names = await input.evaluate((el) => Array.from((el as HTMLInputElement).files ?? []).map((f) => f.name));
      if (names.length !== 1) return { error: 'the file input did not accept the file' };
      return { verified: `input now holds "${names[0]}"` };
    }
    case 'press':
      await page.keyboard.press(action.key);
      return { verified: await settle(page) };
    case 'waitFor':
      await page.locator(action.selector).first().waitFor({ state: 'visible' });
      return { verified: 'element is visible' };
    case 'extract': {
      const matches = await page.locator(action.selector).all();
      const attribute = action.attribute;
      const data = await Promise.all(matches.map(async (m) => (attribute ? ((await m.getAttribute(attribute)) ?? '') : (await m.innerText()).trim())));
      if (data.length === 0) return { error: 'selector matched no elements' };
      return { verified: `${data.length} element(s) matched`, data };
    }
  }
}

const DETAIL: { [K in Action['action']]: (a: Extract<Action, { action: K }>) => string } = {
  goto: (a) => a.url,
  click: (a) => a.selector,
  fill: (a) => `${a.selector} (${a.value.length} chars)`,
  upload: (a) => `${a.selector} ← ${a.path}`,
  press: (a) => a.key,
  waitFor: (a) => a.selector,
  extract: (a) => (a.attribute ? `${a.selector} @${a.attribute}` : a.selector),
};

/** Performs one browser action and reports what was verified afterwards. Never throws for action failures. */
export async function perform(page: Page, action: Action, check: NetworkGuard, guardPath: PathGuard): Promise<ActionOutcome> {
  const detail = (DETAIL[action.action] as (a: Action) => string)(action);
  const changed = action.action !== 'extract' && action.action !== 'waitFor';
  try {
    const result = await run(page, action, check, guardPath);
    return { ok: !result.error, detail, changed, ...result };
  } catch (err) {
    return { ok: false, detail, changed, error: errMessage(err).split('\n')[0]! };
  }
}
