import { and, eq, inArray, sql } from 'drizzle-orm';
import { RpcError } from '@viscosity/protocol';
import { alert, type Ctx } from '../context';
import { schema } from '../db';
import type { Hello } from '../hub/workers';

const ACTIVE = ['starting', 'running', 'waiting_approval'];
const TERMINAL = ['completed', 'failed', 'stopped', 'lost'];
export const isActive = (status: string) => status === 'queued' || ACTIVE.includes(status);
export const isTerminal = (status: string) => TERMINAL.includes(status);

type Kind = 'agent' | 'browser';
const tables = { agent: schema.agentSessions, browser: schema.browserSessions } as const;

/**
 * Runs when a worker (re)connects. The worker is the source of truth for what is
 * actually running, so:
 *  1. anything it logged while we were disconnected is replayed (idempotent by seq),
 *  2. sessions we believe are running but the worker does not have are marked `lost`,
 *  3. sessions queued while the server was offline are started.
 */
export async function reconcile(ctx: Ctx, kind: Kind, serverId: string, known: Hello['agents'], startQueued: (id: string) => Promise<void>) {
  const { db, hub, dash } = ctx;
  const T = tables[kind];
  const rows = await db.select({ id: T.id, status: T.status, lastSeq: T.lastSeq, statusDetail: T.statusDetail }).from(T).where(eq(T.serverId, serverId));
  const byId = new Map(known.map((k) => [k.id, k]));

  for (const row of rows) {
    const k = byId.get(row.id);
    if (k && k.lastSeq > row.lastSeq) {
      try {
        await hub.call(serverId, `${kind}.replay`, { sessionId: row.id, afterSeq: row.lastSeq }, 60_000);
      } catch (err) {
        ctx.log.error({ err, sessionId: row.id }, `${kind} replay failed`);
      }
    }
  }

  // Replayed events are queued behind this handler; decide "lost" only after they are applied.
  void hub.drained(serverId).then(async () => {
    const current = await db.select({ id: T.id, status: T.status, name: T.name }).from(T)
      .where(and(eq(T.serverId, serverId), inArray(T.status, ACTIVE)));
    for (const row of current) {
      if (byId.get(row.id)?.active) continue;
      await db.update(T).set({ status: 'lost', statusDetail: 'The worker no longer has this session (it was restarted while the session was running).', endedAt: new Date() })
        .where(eq(T.id, row.id));
      await expireApprovals(ctx, row.id);
      dash.publish(`${kind}s`, { id: row.id, status: 'lost' });
      dash.publish(`${kind}:${row.id}`, { status: 'lost' });
      await alert(ctx, { level: 'error', title: `${row.name} was lost`, body: 'The worker restarted while it was running.', serverId, link: `${kind}:${row.id}` });
    }
    // Only sessions parked while the server was offline. One created a moment ago is also `queued`
    // here but is already being started by its creator; starting it again would be a duplicate.
    for (const row of rows) if (row.status === 'queued' && row.statusDetail === WAITING_OFFLINE && !byId.has(row.id)) await startQueued(row.id);
  }).catch((err) => ctx.log.error({ err, serverId }, `${kind} reconcile failed`));
}

/** Marker set on a queued session whose start was deferred because its server was offline. */
export const WAITING_OFFLINE = 'Waiting for the server to come online.';

export async function expireApprovals(ctx: Ctx, sessionId: string) {
  await ctx.db.update(schema.approvals).set({ status: 'expired', decidedAt: new Date() })
    .where(and(eq(schema.approvals.sessionId, sessionId), eq(schema.approvals.status, 'pending')));
}

export async function recordApprovalRequest(ctx: Ctx, a: { kind: Kind; sessionId: string; serverId: string; approvalId: string; summary: string; payload: unknown; name: string }) {
  await ctx.db.insert(schema.approvals).values({ kind: a.kind, sessionId: a.sessionId, serverId: a.serverId, approvalId: a.approvalId, summary: a.summary, payload: a.payload })
    .onConflictDoNothing();
  ctx.dash.publish('approvals', { sessionId: a.sessionId });
  await alert(ctx, { level: 'warning', title: `${a.name} needs approval`, body: a.summary, serverId: a.serverId, link: `${a.kind}:${a.sessionId}` });
}

export async function recordApprovalResolved(ctx: Ctx, sessionId: string, approvalId: string, decision: 'allow' | 'deny') {
  await ctx.db.update(schema.approvals).set({ status: decision === 'allow' ? 'allowed' : 'denied', decidedAt: sql`coalesce(decided_at, now())` })
    .where(and(eq(schema.approvals.sessionId, sessionId), eq(schema.approvals.approvalId, approvalId)));
  ctx.dash.publish('approvals', { sessionId });
}

/** A start RPC that failed because the server is offline leaves the session queued; anything else is a real failure. */
export const isOffline = (err: unknown) => err instanceof RpcError && err.code === 'offline';
