import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { lt, ne } from 'drizzle-orm';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { RpcError } from '@viscosity/protocol';
import { registerAuth } from './auth';
import type { Config } from './config';
import { HttpError, rpcStatus, type Ctx } from './context';
import { makeSecretBox } from './crypto';
import { createDb, runMigrations, schema } from './db';
import { DashboardHub } from './hub/dashboard';
import { WorkerHub } from './hub/workers';
import { agentRoutes } from './routes/agents';
import { authRoutes } from './routes/auth';
import { browserRoutes } from './routes/browser';
import { deploymentRoutes } from './routes/deployments';
import { miscRoutes } from './routes/misc';
import { opsRoutes } from './routes/ops';
import { projectRoutes } from './routes/projects';
import { serverRoutes } from './routes/servers';
import { terminalRoutes } from './routes/terminals';
import { userRoutes } from './routes/users';
import { workflowRoutes } from './routes/workflows';
import { agentService } from './services/agents';
import { browserService } from './services/browser';
import { workflowService } from './services/workflows';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  const { db, client } = createDb(config.databaseUrl);
  await runMigrations(db, config.migrationsDir);
  // No worker is connected to a freshly started control plane.
  await db.update(schema.servers).set({ status: 'offline' }).where(ne(schema.servers.status, 'pending'));

  const ctx: Ctx = { config, db, hub: new WorkerHub(app.log), dash: new DashboardHub(), box: makeSecretBox(config.secretKey), log: app.log, closing: false };

  await app.register(cookie);
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  // Uploads stream straight through to the worker instead of being buffered.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.extra });
    if (err instanceof RpcError) return reply.status(rpcStatus(err)).send({ error: err.message, code: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal error' });
  });

  registerAuth(app, ctx);
  authRoutes(app, ctx);
  serverRoutes(app, ctx);
  opsRoutes(app, ctx);
  terminalRoutes(app, ctx);
  const agents = agentService(ctx);
  agentRoutes(app, ctx, agents);
  const browsers = browserService(ctx);
  browserRoutes(app, ctx, browsers);
  projectRoutes(app, ctx, agents);
  deploymentRoutes(app, ctx, agents);
  const workflows = workflowService(ctx, agents, browsers);
  workflowRoutes(app, ctx, workflows);
  miscRoutes(app, ctx);
  userRoutes(app, ctx);

  // Live metrics fan-out (droppable: the next sample supersedes it).
  ctx.hub.on('metrics', (serverId, m) => ctx.dash.publish(`server:${serverId}`, m, true));

  // Long-range history: one persisted sample per server per interval, pruned after 14 days.
  const lastSample = new Map<string, number>();
  ctx.hub.on('metrics', async (serverId, m) => {
    if (m.ts - (lastSample.get(serverId) ?? 0) < config.metricSampleMs) return;
    lastSample.set(serverId, m.ts);
    await db.insert(schema.metricSamples).values({
      serverId, ts: new Date(m.ts), cpu: m.cpu, memUsed: m.memTotal - m.memAvailable, memTotal: m.memTotal,
      diskUsed: m.diskUsed, diskTotal: m.diskTotal, netRxBps: m.netRxBps, netTxBps: m.netTxBps,
    }).onConflictDoNothing();
  });
  const prune = setInterval(() => {
    void db.delete(schema.metricSamples).where(lt(schema.metricSamples.ts, new Date(Date.now() - 14 * 86_400_000)))
      .catch((err) => app.log.error({ err }, 'metric pruning failed'));
  }, 3_600_000);
  prune.unref();

  app.get('/ws/events', { websocket: true }, (socket) => ctx.dash.add(socket));

  app.addHook('onReady', async () => workflows.start());
  app.addHook('onClose', async () => {
    ctx.closing = true;
    clearInterval(prune);
    workflows.stop();
    ctx.hub.closeAll();
    ctx.dash.closeAll();
    await client.end({ timeout: 5 });
  });
  return { app, ctx, workflows };
}
