import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { createReadStream, existsSync } from 'node:fs';
import { z } from 'zod';
import { BrowserStep } from '@viscosity/protocol';
import { audit, HttpError, me, type Ctx } from '../context';
import { schema } from '../db';
import type { BrowserService } from '../services/browser';
import { isActive } from '../services/sessions';

const Id = z.object({ id: z.string().uuid() });
const Create = z.object({
  serverId: z.string().uuid(),
  name: z.string().trim().max(80).optional(),
  mode: z.enum(['steps', 'agent']),
  startUrl: z.string().url().optional(),
  task: z.string().trim().max(20_000).optional(),
  steps: z.array(BrowserStep).min(1).max(200).optional(),
  credentialId: z.string().uuid().optional(),
  model: z.string().trim().max(100).optional(),
});

export function browserRoutes(app: FastifyInstance, ctx: Ctx, browsers: BrowserService) {
  const { db, hub } = ctx;
  const B = schema.browserSessions;
  const view = (r: typeof B.$inferSelect) => ({ ...r, serverOnline: hub.isOnline(r.serverId) });

  app.get('/api/browser', async () => (await db.select().from(B).orderBy(desc(B.createdAt)).limit(300)).map(view));

  app.post('/api/browser', async (req) => view(await browsers.create(Create.parse(req.body), me(req).id)));

  app.get('/api/browser/:id', async (req) => {
    const row = await browsers.get(Id.parse(req.params).id);
    const approvals = await db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.sessionId, row.id), eq(schema.approvals.status, 'pending')));
    return { ...view(row), approvals };
  });

  app.get('/api/browser/:id/events', async (req) => {
    const { id } = Id.parse(req.params);
    const q = z.object({ after: z.coerce.number().int().default(0) }).parse(req.query);
    const E = schema.browserEvents;
    const rows = await db.select().from(E).where(and(eq(E.sessionId, id), gt(E.seq, q.after))).orderBy(asc(E.seq)).limit(2000);
    return rows.map((r) => ({ sessionId: r.sessionId, seq: r.seq, ts: r.ts.getTime(), event: r.data }));
  });

  app.get('/api/browser/:id/screenshots/:seq', async (req, reply) => {
    const { id, seq } = z.object({ id: z.string().uuid(), seq: z.coerce.number().int().positive() }).parse(req.params);
    const file = browsers.shotPath(id, seq);
    if (!existsSync(file)) throw new HttpError(404, 'screenshot not found');
    return reply.type('image/jpeg').header('cache-control', 'private, max-age=86400, immutable').send(createReadStream(file));
  });

  app.post('/api/browser/:id/stop', async (req) => {
    const row = await browsers.get(Id.parse(req.params).id);
    if (row.status === 'queued') {
      await db.update(B).set({ status: 'stopped', statusDetail: 'Cancelled before it started.', endedAt: new Date() }).where(eq(B.id, row.id));
      ctx.dash.publish('browsers', { id: row.id, status: 'stopped' });
    } else {
      if (!isActive(row.status)) throw new HttpError(409, `session is already ${row.status}`);
      await hub.call(row.serverId, 'browser.stop', { sessionId: row.id });
    }
    await audit(ctx, req, 'browser.stop', row.name, { serverId: row.serverId });
    return { ok: true };
  });

  /** Run the same task/steps again in a fresh isolated browser. */
  app.post('/api/browser/:id/restart', async (req) => {
    const row = await browsers.get(Id.parse(req.params).id);
    if (isActive(row.status)) throw new HttpError(409, 'stop the session before restarting it');
    await browsers.launch(row);
    await audit(ctx, req, 'browser.restart', row.name, { serverId: row.serverId });
    return { ok: true };
  });

  app.post('/api/browser/:id/approvals/:approvalId', async (req) => {
    const { id, approvalId } = z.object({ id: z.string().uuid(), approvalId: z.string().max(200) }).parse(req.params);
    const body = z.object({ decision: z.enum(['allow', 'deny']) }).parse(req.body);
    const row = await browsers.get(id);
    await hub.call(row.serverId, 'browser.approve', { sessionId: id, approvalId, decision: body.decision });
    await db.update(schema.approvals).set({ decidedBy: me(req).id })
      .where(and(eq(schema.approvals.sessionId, id), eq(schema.approvals.approvalId, approvalId)));
    await audit(ctx, req, `browser.approval_${body.decision}`, row.name, { serverId: row.serverId, detail: { approvalId } });
    return { ok: true };
  });
}
