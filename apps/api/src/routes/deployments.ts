import type { FastifyInstance, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { hasRole } from '../auth';
import { audit, HttpError, me, type Ctx } from '../context';
import { schema } from '../db';
import type { AgentService } from '../services/agents';
import { composeProject, deploymentService, type Deployment } from '../services/deployments';

const Id = z.object({ id: z.string().uuid() });
const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'environment variable names use letters, digits and underscores').max(128);
// relative to the working directory, no traversal
const ComposeFile = z.string().trim().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/, 'compose file must be a relative path inside the working directory').max(200);
const Fields = {
  name: z.string().trim().min(1).max(80),
  workdir: z.string().trim().min(1).max(4096),
  composeFile: ComposeFile,
  environment: z.enum(['staging', 'production']),
  buildCommand: z.array(z.string().max(4096)).max(64).nullable(),
  healthUrl: z.string().url().max(2000).nullable(),
};
const Version = z.string().trim().regex(/^(?!-)[\w./@-]+$/, 'not a valid branch, tag or commit').max(200);

/** Docker Compose deployments: which application runs where, how it got there, and how to go back. */
export function deploymentRoutes(app: FastifyInstance, ctx: Ctx, agents: AgentService) {
  const { db, hub } = ctx;
  const D = schema.deployments;
  const R = schema.deploymentReleases;
  const svc = deploymentService(ctx, agents);

  void svc.recoverInterrupted().catch((err) => ctx.log.error({ err }, 'could not recover interrupted deployments'));
  svc.startMonitor();
  app.addHook('onClose', async () => svc.stopMonitor());

  /** Secrets never leave the API: only the variable names are returned. */
  const view = (d: Deployment) => {
    const { envEnc: _envEnc, ...rest } = d;
    return { ...rest, envKeys: Object.keys(svc.envOf(d)).sort(), composeProject: composeProject(d), serverOnline: hub.isOnline(d.serverId) };
  };
  const isAdmin = (req: FastifyRequest) => hasRole(me(req).role, 'admin');
  /** Production is changed by administrators only (operators may still *request* a production deploy). */
  const guardProduction = (req: FastifyRequest, environment: string) => {
    if (environment === 'production' && !isAdmin(req)) throw new HttpError(403, 'production deployments can only be changed by an administrator');
  };
  const load = async (req: FastifyRequest) => svc.get(Id.parse(req.params).id);

  app.get('/api/deployments', async () => {
    const rows = await db.select().from(D).orderBy(desc(D.createdAt));
    const releases = await db.select().from(R);
    return rows.map((d) => {
      const current = releases.find((r) => r.id === d.currentReleaseId);
      return { ...view(d), current: current ? { version: current.version, finishedAt: current.finishedAt, status: current.status } : null };
    });
  });

  app.get('/api/deployments/:id', async (req) => {
    const d = await load(req);
    const requester = alias(schema.users, 'requester');
    const approver = alias(schema.users, 'approver');
    const releases = await db.select({
      id: R.id, version: R.version, trigger: R.trigger, status: R.status, sessionId: R.sessionId, health: R.health, detail: R.detail,
      createdAt: R.createdAt, finishedAt: R.finishedAt, requestedBy: requester.email, approvedBy: approver.email,
    }).from(R).leftJoin(requester, eq(requester.id, R.requestedBy)).leftJoin(approver, eq(approver.id, R.approvedBy))
      .where(eq(R.deploymentId, d.id)).orderBy(desc(R.createdAt)).limit(100);
    // Containers are live state: when they cannot be listed, say why instead of showing an empty list.
    let containers: Awaited<ReturnType<typeof svc.containers>> = [];
    let containersError: string | null = null;
    try {
      containers = await svc.containers(d);
    } catch (err) {
      containersError = err instanceof Error ? err.message : String(err);
    }
    return { ...view(d), releases, containers, containersError };
  });

  app.post('/api/deployments', async (req) => {
    const body = z.object({
      ...Fields, serverId: z.string().uuid(), projectId: z.string().uuid().nullable().default(null),
      composeFile: ComposeFile.default('docker-compose.yml'), buildCommand: Fields.buildCommand.default(null), healthUrl: Fields.healthUrl.default(null),
      env: z.record(EnvKey, z.string().max(32_768)).default({}),
    }).parse(req.body);
    guardProduction(req, body.environment);
    const [server] = await db.select().from(schema.servers).where(eq(schema.servers.id, body.serverId));
    if (!server) throw new HttpError(404, 'server not found');
    const { env, ...rest } = body;
    const [d] = await db.insert(D).values({
      ...rest, buildCommand: rest.buildCommand?.length ? rest.buildCommand : null,
      envEnc: Object.keys(env).length ? ctx.box.encrypt(JSON.stringify(env)) : null, createdBy: me(req).id,
    }).returning();
    await audit(ctx, req, 'deployment.create', d!.name, { serverId: d!.serverId, detail: { environment: d!.environment, workdir: d!.workdir, envKeys: Object.keys(env) } });
    ctx.dash.publish('deployments', { id: d!.id });
    return view(d!);
  });

  app.patch('/api/deployments/:id', async (req) => {
    const d = await load(req);
    const body = z.object({
      name: Fields.name.optional(), workdir: Fields.workdir.optional(), composeFile: Fields.composeFile.optional(), environment: Fields.environment.optional(),
      buildCommand: Fields.buildCommand.optional(), healthUrl: Fields.healthUrl.optional(),
      /** provided keys replace, null deletes, omitted keys are kept */
      env: z.record(EnvKey, z.string().max(32_768).nullable()).optional(),
    }).parse(req.body);
    guardProduction(req, d.environment);
    if (body.environment) guardProduction(req, body.environment);
    const { env: envPatch, ...fields } = body;
    const patch: Partial<typeof D.$inferInsert> = { ...fields };
    if (fields.buildCommand !== undefined) patch.buildCommand = fields.buildCommand?.length ? fields.buildCommand : null;
    if (envPatch) {
      const env = svc.envOf(d);
      for (const [k, v] of Object.entries(envPatch)) {
        if (v === null) delete env[k];
        else env[k] = v;
      }
      patch.envEnc = Object.keys(env).length ? ctx.box.encrypt(JSON.stringify(env)) : null;
    }
    const [updated] = await db.update(D).set(patch).where(eq(D.id, d.id)).returning();
    // values are never written to the audit log, only which keys changed
    await audit(ctx, req, 'deployment.update', d.name, { serverId: d.serverId, detail: { ...fields, envKeys: envPatch ? Object.keys(envPatch) : undefined } });
    ctx.dash.publish('deployments', { id: d.id });
    return view(updated!);
  });

  app.delete('/api/deployments/:id', async (req) => {
    const d = await load(req);
    guardProduction(req, d.environment);
    const { down } = z.object({ down: z.enum(['0', '1']).default('0') }).parse(req.query);
    // `down` removes the project's containers and networks first; if that cannot be done the record is kept.
    if (down === '1') await svc.runCompose(d, 'Remove', me(req).id, 'down', '--remove-orphans');
    await db.delete(D).where(eq(D.id, d.id));
    await audit(ctx, req, 'deployment.delete', d.name, { serverId: d.serverId, detail: { down: down === '1' } });
    ctx.dash.publish('deployments', { id: d.id });
    return { ok: true };
  });

  app.post('/api/deployments/:id/deploy', async (req) => {
    const d = await load(req);
    const { version } = z.object({ version: Version.nullish() }).parse(req.body ?? {});
    const canDeploy = d.environment !== 'production' || isAdmin(req);
    const release = await svc.request(d, { version, trigger: 'manual', userId: me(req).id, canDeploy });
    await audit(ctx, req, canDeploy ? 'deployment.deploy' : 'deployment.deploy_requested', d.name, { serverId: d.serverId, detail: { version: version ?? null, environment: d.environment } });
    return release;
  });

  app.post('/api/deployments/:id/rollback', async (req) => {
    const d = await load(req);
    const { releaseId } = z.object({ releaseId: z.string().uuid() }).parse(req.body);
    const [target] = await db.select().from(R).where(eq(R.id, releaseId));
    if (!target || target.deploymentId !== d.id) throw new HttpError(404, 'release not found');
    if (!target.version) throw new HttpError(400, 'that release has no recorded version (the working directory was not a git repository), so it cannot be rolled back to');
    const canDeploy = d.environment !== 'production' || isAdmin(req);
    const release = await svc.request(d, { version: target.version, trigger: 'rollback', userId: me(req).id, canDeploy });
    await audit(ctx, req, canDeploy ? 'deployment.rollback' : 'deployment.rollback_requested', d.name, { serverId: d.serverId, detail: { version: target.version } });
    return release;
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/api/deployments/:id/releases/:rid/${action}`, { config: { role: 'admin' } }, async (req) => {
      const d = await load(req);
      const { rid } = z.object({ rid: z.string().uuid() }).parse(req.params);
      await svc.decide(d, rid, action === 'approve', me(req).id);
      await audit(ctx, req, `deployment.${action}`, d.name, { serverId: d.serverId, detail: { releaseId: rid } });
      return { ok: true };
    });
  }

  app.get('/api/deployments/:id/health', async (req) => svc.checkHealth(await load(req)));

  app.post('/api/deployments/:id/stop', async (req) => {
    const d = await load(req);
    guardProduction(req, d.environment);
    await audit(ctx, req, 'deployment.stop', d.name, { serverId: d.serverId });
    await svc.runCompose(d, 'Stop', me(req).id, 'stop');
    await db.update(D).set({ status: 'idle' }).where(eq(D.id, d.id));
    ctx.dash.publish('deployments', { id: d.id });
    return { ok: true };
  });
}
