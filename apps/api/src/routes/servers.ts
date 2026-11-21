import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EnrollRequest, PROTOCOL_VERSION, SystemInfo, type EnrollResponse } from '@viscosity/protocol';
import { alert, audit, HttpError, type Ctx } from '../context';
import { hashToken, newToken, safeEqualHex } from '../crypto';
import { schema } from '../db';

const ENROLL_TTL_MS = 15 * 60_000;
const Id = z.object({ id: z.string().uuid() });

export function serverRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub, dash, config } = ctx;
  const S = schema.servers;

  const view = (s: typeof S.$inferSelect) => ({
    id: s.id, name: s.name, system: s.system, remoteIp: s.remoteIp, lastSeenAt: s.lastSeenAt, createdAt: s.createdAt,
    enrolled: s.credentialHash !== null,
    // Never trust the stored status alone: online means a live socket right now.
    status: hub.isOnline(s.id) ? 'online' : s.status === 'pending' ? 'pending' : 'offline',
    metrics: hub.latestMetrics(s.id),
  });

  async function getServer(id: string) {
    const [s] = await db.select().from(S).where(eq(S.id, id));
    if (!s) throw new HttpError(404, 'server not found');
    return s;
  }

  async function issueEnrollment(serverId: string) {
    // one live token per server
    await db.delete(schema.enrollmentTokens).where(and(eq(schema.enrollmentTokens.serverId, serverId), isNull(schema.enrollmentTokens.usedAt)));
    const token = newToken();
    const expiresAt = new Date(Date.now() + ENROLL_TTL_MS);
    await db.insert(schema.enrollmentTokens).values({ serverId, tokenHash: hashToken(token), expiresAt });
    return {
      token, expiresAt,
      command: `curl -fsSL ${config.workerUrl}/install.sh | sudo bash -s -- --url ${config.workerUrl} --token ${token}`,
    };
  }

  app.get('/api/servers', async () => (await db.select().from(S).orderBy(S.createdAt)).map(view));

  app.get('/api/servers/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const s = await getServer(id);
    const connections = await db.select().from(schema.serverConnections)
      .where(eq(schema.serverConnections.serverId, id)).orderBy(desc(schema.serverConnections.connectedAt)).limit(10);
    return { ...view(s), history: hub.metricHistory(id), connections };
  });

  app.post('/api/servers', { config: { role: 'admin' } }, async (req) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const [s] = await db.insert(S).values({ name, createdBy: req.user!.id }).returning();
    await audit(ctx, req, 'server.created', name, { serverId: s!.id });
    dash.publish('servers', { id: s!.id });
    return { server: view(s!), enrollment: await issueEnrollment(s!.id) };
  });

  /** New enrollment command. For an enrolled server this is credential rotation: the old credential dies when the new one is used. */
  app.post('/api/servers/:id/enrollment', { config: { role: 'admin' } }, async (req) => {
    const { id } = Id.parse(req.params);
    const s = await getServer(id);
    await audit(ctx, req, 'server.enrollment_issued', s.name, { serverId: id });
    return issueEnrollment(id);
  });

  app.patch('/api/servers/:id', { config: { role: 'admin' } }, async (req) => {
    const { id } = Id.parse(req.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    await getServer(id);
    const [s] = await db.update(S).set({ name }).where(eq(S.id, id)).returning();
    dash.publish('servers', { id });
    return view(s!);
  });

  /** Revoke the worker credential and drop its connection. The server must be re-enrolled to come back. */
  app.post('/api/servers/:id/revoke', { config: { role: 'admin' } }, async (req) => {
    const { id } = Id.parse(req.params);
    const s = await getServer(id);
    await db.update(S).set({ credentialHash: null, status: 'pending' }).where(eq(S.id, id));
    hub.disconnect(id, 'credential revoked');
    await audit(ctx, req, 'server.credential_revoked', s.name, { serverId: id });
    dash.publish('servers', { id });
    return { ok: true };
  });

  app.delete('/api/servers/:id', { config: { role: 'admin' } }, async (req) => {
    const { id } = Id.parse(req.params);
    const s = await getServer(id);
    await db.delete(S).where(eq(S.id, id));
    hub.disconnect(id, 'server removed');
    await audit(ctx, req, 'server.deleted', s.name, { serverId: id });
    dash.publish('servers', { id });
    return { ok: true };
  });

  // ── worker-facing ──

  app.post('/api/worker/enroll', { config: { worker: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<EnrollResponse> => {
    const body = EnrollRequest.parse(req.body);
    if (body.protocol !== PROTOCOL_VERSION)
      throw new HttpError(400, `protocol mismatch: control plane speaks v${PROTOCOL_VERSION}, worker v${body.protocol}`);
    // Atomic single use: the UPDATE only succeeds for an unused, unexpired token.
    const [tok] = await db.update(schema.enrollmentTokens).set({ usedAt: new Date() })
      .where(and(eq(schema.enrollmentTokens.tokenHash, hashToken(body.token)), isNull(schema.enrollmentTokens.usedAt), gt(schema.enrollmentTokens.expiresAt, new Date())))
      .returning();
    if (!tok) {
      await audit(ctx, req, 'worker.enroll_rejected', body.hostname);
      throw new HttpError(401, 'enrollment token is invalid, expired, or already used');
    }
    const secret = newToken();
    await db.update(S).set({ credentialHash: hashToken(secret), status: 'offline' }).where(eq(S.id, tok.serverId));
    hub.disconnect(tok.serverId, 'credential rotated'); // any connection using the previous credential
    await audit(ctx, req, 'worker.enrolled', body.hostname, { serverId: tok.serverId });
    return { serverId: tok.serverId, secret };
  });

  app.get('/ws/worker', {
    websocket: true,
    config: { worker: true },
    preValidation: async (req) => {
      const m = /^Bearer ([0-9a-f-]{36})\.([\w-]+)$/.exec(req.headers.authorization ?? '');
      if (!m) throw new HttpError(401, 'missing worker credential');
      const [s] = await db.select().from(S).where(eq(S.id, m[1]!));
      if (!s?.credentialHash || !safeEqualHex(s.credentialHash, hashToken(m[2]!))) {
        await audit(ctx, req, 'worker.auth_rejected', m[1]);
        throw new HttpError(401, 'worker credential rejected');
      }
      (req as typeof req & { serverId: string }).serverId = s.id;
    },
  }, (socket, req) => {
    const serverId = (req as typeof req & { serverId: string }).serverId;
    const ip = req.ip;
    let connectionId: string | undefined;
    const helloTimer = setTimeout(() => socket.close(4002, 'no hello received'), 10_000);

    socket.once('message', (raw) => {
      clearTimeout(helloTimer);
      // The first frame must be a valid hello; everything after goes through the hub.
      void (async () => {
        const first = z.object({ t: z.literal('hello'), protocol: z.number(), system: SystemInfo }).safeParse(JSON.parse(raw.toString()));
        if (!first.success) return socket.close(4002, 'expected hello');
        if (first.data.protocol !== PROTOCOL_VERSION) return socket.close(4003, `protocol v${PROTOCOL_VERSION} required`);
        const { system } = first.data;
        await db.update(S).set({ status: 'online', system, remoteIp: ip, lastSeenAt: new Date() }).where(eq(S.id, serverId));
        const [c] = await db.insert(schema.serverConnections).values({ serverId, remoteIp: ip, workerVersion: system.workerVersion }).returning();
        connectionId = c!.id;
        dash.publish('servers', { id: serverId, status: 'online' });
        hub.emitHello(serverId, JSON.parse(raw.toString()));
      })().catch((err) => {
        ctx.log.error({ err, serverId }, 'worker hello failed');
        socket.close(1011, 'hello failed');
      });
    });

    // Attach synchronously so no frame after hello is missed.
    hub.attach(serverId, socket, () => {
      // On shutdown nothing needs recording: every server is reset to offline at the next start.
      if (ctx.closing) return;
      void (async () => {
        await db.update(S).set({ status: 'offline', lastSeenAt: new Date() }).where(and(eq(S.id, serverId), ne(S.status, 'pending')));
        if (connectionId) await db.update(schema.serverConnections).set({ disconnectedAt: new Date() }).where(eq(schema.serverConnections.id, connectionId));
        dash.publish('servers', { id: serverId, status: 'offline' });
        const [s] = await db.select({ name: S.name }).from(S).where(eq(S.id, serverId));
        if (s) await alert(ctx, { level: 'warning', title: `${s.name} went offline`, serverId, link: `server:${serverId}` });
      })().catch((err) => ctx.log.error({ err, serverId }, 'failed to record worker disconnect'));
    });
  });

  // ── worker distribution ──
  const installScript = [path.resolve(import.meta.dirname, '../../../../deploy/install-worker.sh'), path.resolve(import.meta.dirname, '../install-worker.sh')]
    .find((p) => existsSync(p));
  app.get('/install.sh', { config: { public: true } }, async (_req, reply) => {
    if (!installScript) throw new HttpError(404, 'install script is not bundled with this build');
    return reply.type('text/x-shellscript').send(readFileSync(installScript, 'utf8'));
  });
  app.get('/api/worker/bundle.tgz', { config: { public: true } }, async (_req, reply) => {
    if (!config.workerBundle || !existsSync(config.workerBundle))
      throw new HttpError(404, 'worker bundle not built; run `pnpm --filter @viscosity/worker build` and set WORKER_BUNDLE');
    return reply.type('application/gzip').send(createReadStream(config.workerBundle));
  });
}
