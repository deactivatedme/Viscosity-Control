import type { FastifyInstance } from 'fastify';
import { desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { audit, HttpError, type Ctx } from '../context';
import { schema } from '../db';

const Id = z.object({ id: z.string().uuid() });
const Kind = z.enum(['anthropic', 'openai', 'github', 'secret']);

export function miscRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, box, dash } = ctx;
  const C = schema.credentials;
  // The secret itself is never returned by any endpoint.
  const credView = (c: typeof C.$inferSelect) => ({ id: c.id, kind: c.kind, label: c.label, hint: c.hint, createdAt: c.createdAt, rotatedAt: c.rotatedAt });
  const hint = (secret: string) => `…${secret.slice(-4)}`;

  app.get('/api/credentials', async () => (await db.select().from(C).orderBy(C.createdAt)).map(credView));

  app.post('/api/credentials', { config: { role: 'admin' } }, async (req) => {
    const body = z.object({ kind: Kind, label: z.string().trim().min(1).max(80), secret: z.string().trim().min(1).max(4096) }).parse(req.body);
    const [row] = await db.insert(C).values({ kind: body.kind, label: body.label, secretEnc: box.encrypt(body.secret), hint: hint(body.secret), createdBy: req.user!.id }).returning();
    await audit(ctx, req, 'credential.create', `${body.kind}:${body.label}`);
    return credView(row!);
  });

  app.put('/api/credentials/:id', { config: { role: 'admin' } }, async (req) => {
    const { id } = Id.parse(req.params);
    const { secret } = z.object({ secret: z.string().trim().min(8).max(4096) }).parse(req.body);
    const [row] = await db.update(C).set({ secretEnc: box.encrypt(secret), hint: hint(secret), rotatedAt: new Date() }).where(eq(C.id, id)).returning();
    if (!row) throw new HttpError(404, 'credential not found');
    await audit(ctx, req, 'credential.rotate', `${row.kind}:${row.label}`);
    return credView(row);
  });

  app.delete('/api/credentials/:id', { config: { role: 'admin' } }, async (req) => {
    const { id } = Id.parse(req.params);
    const [row] = await db.delete(C).where(eq(C.id, id)).returning();
    if (!row) throw new HttpError(404, 'credential not found');
    await audit(ctx, req, 'credential.delete', `${row.kind}:${row.label}`);
    return { ok: true };
  });

  // ── notifications ──
  app.get('/api/alerts', async () => db.select().from(schema.alerts).orderBy(desc(schema.alerts.createdAt)).limit(100));
  app.post('/api/alerts/read', { config: { role: 'viewer' } }, async () => {
    await db.update(schema.alerts).set({ readAt: new Date() }).where(isNull(schema.alerts.readAt));
    dash.publish('alerts', { read: true });
    return { ok: true };
  });

  app.get('/api/approvals', async () =>
    db.select().from(schema.approvals).where(eq(schema.approvals.status, 'pending')).orderBy(desc(schema.approvals.createdAt)));

  app.get('/api/audit', { config: { role: 'admin' } }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    return db.select({
      id: schema.auditLogs.id, ts: schema.auditLogs.ts, action: schema.auditLogs.action, target: schema.auditLogs.target,
      serverId: schema.auditLogs.serverId, detail: schema.auditLogs.detail, ip: schema.auditLogs.ip, user: schema.users.email,
    }).from(schema.auditLogs).leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
      .orderBy(desc(schema.auditLogs.id)).limit(limit);
  });

  // ── global search ──
  app.get('/api/search', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const [servers, agents, browsers] = await Promise.all([
      db.select({ id: schema.servers.id, name: schema.servers.name }).from(schema.servers).where(ilike(schema.servers.name, like)).limit(8),
      db.select({ id: schema.agentSessions.id, name: schema.agentSessions.name, status: schema.agentSessions.status }).from(schema.agentSessions)
        .where(or(ilike(schema.agentSessions.name, like), ilike(schema.agentSessions.task, like))).orderBy(desc(schema.agentSessions.createdAt)).limit(8),
      db.select({ id: schema.browserSessions.id, name: schema.browserSessions.name, status: schema.browserSessions.status }).from(schema.browserSessions)
        .where(ilike(schema.browserSessions.name, like)).orderBy(desc(schema.browserSessions.createdAt)).limit(8),
    ]);
    return { servers, agents, browsers };
  });
}
