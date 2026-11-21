import { and, eq, sql } from 'drizzle-orm';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserEventEnvelope } from '@viscosity/protocol';
import { alert, audit, HttpError, type Ctx } from '../context';
import { schema } from '../db';
import { expireApprovals, isOffline, isTerminal, reconcile, recordApprovalRequest, recordApprovalResolved } from './sessions';

const B = schema.browserSessions;
type Row = typeof B.$inferSelect;

export interface BrowserInput {
  serverId: string; name?: string; mode: Row['mode']; startUrl?: string; task?: string; steps?: unknown[]; credentialId?: string; model?: string;
}

export function browserService(ctx: Ctx) {
  const { db, hub, dash, box, config } = ctx;
  const shotDir = (id: string) => path.join(config.dataDir, 'browser', id);
  const shotPath = (id: string, seq: number) => path.join(shotDir(id), `${seq}.jpg`);

  async function get(id: string): Promise<Row> {
    const [row] = await db.select().from(B).where(eq(B.id, id));
    if (!row) throw new HttpError(404, 'browser session not found');
    return row;
  }

  async function launch(row: Row) {
    let llm: { apiKey: string; model: string } | undefined;
    if (row.mode === 'agent') {
      const [cred] = row.credentialId ? await db.select().from(schema.credentials).where(eq(schema.credentials.id, row.credentialId)) : [];
      if (!cred || cred.kind !== 'anthropic') throw new HttpError(400, 'an Anthropic credential is required for autonomous browser sessions');
      llm = { apiKey: box.decrypt(cred.secretEnc), model: row.model ?? 'claude-opus-5-5' };
    }
    try {
      // Stored secrets are referenced as {{secret:label}} and resolved only here, so the plaintext
      // is never kept in the session row; the worker is told not to echo the value.
      const steps = await Promise.all(((row.steps as { action?: string; value?: string }[] | null) ?? []).map(async (step) => {
        const m = step.action === 'fill' ? /^\{\{secret:(.+)\}\}$/.exec(step.value ?? '') : null;
        if (!m) return step;
        const [cred] = await db.select().from(schema.credentials).where(and(eq(schema.credentials.kind, 'secret'), eq(schema.credentials.label, m[1]!)));
        if (!cred) throw new HttpError(400, `no stored secret named "${m[1]}" (add it in Settings → AI providers & secrets)`);
        return { ...step, value: box.decrypt(cred.secretEnc), secret: true };
      }));
      await hub.call(row.serverId, 'browser.start', {
        sessionId: row.id, mode: row.mode, startUrl: row.startUrl ?? undefined, task: row.task ?? undefined,
        steps: steps.length ? (steps as never) : undefined, llm,
      });
    } catch (err) {
      if (isOffline(err)) {
        await db.update(B).set({ statusDetail: 'Waiting for the server to come online.' }).where(eq(B.id, row.id));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      await db.update(B).set({ status: 'failed', statusDetail: message, endedAt: new Date() }).where(eq(B.id, row.id));
      dash.publish('browsers', { id: row.id, status: 'failed' });
      throw err;
    }
  }

  async function ingest(serverId: string, env: BrowserEventEnvelope) {
    const [row] = await db.select().from(B).where(eq(B.id, env.sessionId));
    if (!row || row.serverId !== serverId) {
      ctx.log.warn({ serverId, sessionId: env.sessionId }, 'browser event for a session this server does not own; dropped');
      return;
    }
    const ev = env.event;
    // Screenshots go to disk; the event row only records that one exists.
    const stored = ev.type === 'screenshot' ? { type: 'screenshot' as const, url: ev.url } : ev;
    const inserted = await db.insert(schema.browserEvents)
      .values({ sessionId: env.sessionId, seq: env.seq, ts: new Date(env.ts), type: ev.type, data: stored })
      .onConflictDoNothing().returning({ seq: schema.browserEvents.seq });
    if (inserted.length === 0) return;

    const patch: Record<string, unknown> = { lastSeq: sql`greatest(${B.lastSeq}, ${env.seq})` };
    if (ev.type === 'screenshot') {
      await mkdir(shotDir(row.id), { recursive: true });
      await writeFile(shotPath(row.id, env.seq), Buffer.from(ev.data, 'base64'));
      patch.lastScreenshotSeq = env.seq;
      patch.currentUrl = ev.url;
    } else if (ev.type === 'action') {
      patch.currentUrl = ev.url;
    } else if (ev.type === 'status') {
      patch.status = ev.status;
      patch.statusDetail = ev.detail ?? null;
      if (ev.status === 'starting') Object.assign(patch, { startedAt: new Date(env.ts), endedAt: null });
      if (isTerminal(ev.status)) {
        patch.endedAt = new Date(env.ts);
        await expireApprovals(ctx, row.id);
        await alert(ctx, {
          level: ev.status === 'failed' ? 'error' : 'info', title: `${row.name} ${ev.status}`, body: ev.detail, serverId, link: `browser:${row.id}`,
        });
      }
    } else if (ev.type === 'result') {
      patch.result = { ok: ev.ok, summary: ev.summary, data: ev.data ?? null };
    } else if (ev.type === 'approval_request') {
      await recordApprovalRequest(ctx, { kind: 'browser', sessionId: row.id, serverId, approvalId: ev.approvalId, name: row.name, summary: ev.reason, payload: null });
    } else if (ev.type === 'approval_resolved') {
      await recordApprovalResolved(ctx, row.id, ev.approvalId, ev.decision);
    }
    await db.update(B).set(patch).where(eq(B.id, row.id));
    dash.publish(`browser:${row.id}`, { ...env, event: stored });
    if (ev.type === 'status') dash.publish('browsers', { id: row.id, status: ev.status });
  }

  hub.on('browser.event', ingest);
  hub.on('hello', (serverId, hello) =>
    reconcile(ctx, 'browser', serverId, hello.browsers, async (id) => {
      await launch(await get(id)).catch((err) => ctx.log.error({ err, id }, 'failed to start queued browser session'));
    }));

  async function create(input: BrowserInput, userId: string | null, source = 'user'): Promise<Row> {
    if (input.mode === 'steps' && !input.steps?.length) throw new HttpError(400, 'a scripted session needs at least one step');
    if (input.mode === 'agent' && (!input.task || !input.credentialId))
      throw new HttpError(400, 'an autonomous session needs a task and an Anthropic credential');
    const [server] = await db.select().from(schema.servers).where(eq(schema.servers.id, input.serverId));
    if (!server) throw new HttpError(404, 'server not found');
    const [row] = await db.insert(B).values({
      serverId: input.serverId, name: input.name || input.task?.slice(0, 60) || input.startUrl || 'Browser session', mode: input.mode,
      task: input.task ?? null, startUrl: input.startUrl ?? null, steps: input.steps ?? null, credentialId: input.credentialId ?? null,
      model: input.model || null, createdBy: userId,
    }).returning();
    await audit(ctx, null, 'browser.create', row!.name, { serverId: input.serverId, detail: { mode: input.mode, startUrl: input.startUrl, source }, userId });
    dash.publish('browsers', { id: row!.id, status: 'queued' });
    await launch(row!);
    return get(row!.id);
  }

  return { get, launch, create, shotPath };
}
export type BrowserService = ReturnType<typeof browserService>;
