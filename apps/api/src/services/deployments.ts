import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Container, HttpCheck } from '@viscosity/protocol';
import { alert, HttpError, type Ctx } from '../context';
import { schema } from '../db';
import type { AgentService } from './agents';
import { isActive } from './sessions';

const D = schema.deployments;
const R = schema.deploymentReleases;
export type Deployment = typeof D.$inferSelect;
export type Release = typeof R.$inferSelect;

const SESSION_TIMEOUT_MS = 30 * 60_000;
const HEALTH_WAIT_MS = 30_000;
const MONITOR_MS = 60_000;

/** Compose project name: stable for the life of the deployment, valid for `docker compose -p`. */
export const composeProject = (d: Pick<Deployment, 'id' | 'name'>) =>
  `vc-${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app'}-${d.id.slice(0, 8)}`;

export function deploymentService(ctx: Ctx, agents: AgentService) {
  const { db, hub, dash, box } = ctx;
  const envOf = (d: Deployment): Record<string, string> => (d.envEnc ? (JSON.parse(box.decrypt(d.envEnc)) as Record<string, string>) : {});
  const compose = (d: Deployment, ...rest: string[]) => ['docker', 'compose', '-f', d.composeFile, '-p', composeProject(d), ...rest];

  async function get(id: string): Promise<Deployment> {
    const [d] = await db.select().from(D).where(eq(D.id, id));
    if (!d) throw new HttpError(404, 'deployment not found');
    return d;
  }

  async function setStatus(id: string, patch: Partial<typeof D.$inferInsert>) {
    await db.update(D).set(patch).where(eq(D.id, id));
    dash.publish('deployments', { id });
  }

  /** Run a command as a supervised session (its events are the log) and wait for it to end. */
  async function runSession(d: Deployment, label: string, command: string[], userId: string | null, onStart?: (sessionId: string) => Promise<void>) {
    // An offline server would leave the session queued; fail now with the real reason instead of waiting.
    if (!hub.isOnline(d.serverId)) throw new HttpError(503, 'the server is offline');
    const session = await agents.create({
      serverId: d.serverId, provider: 'custom', cwd: d.workdir, permissionMode: 'auto', command, appendPrompt: false,
      prompt: `${label} ${d.name}`, name: `${label} · ${d.name}`, env: envOf(d),
    }, userId, `deployment:${d.id}`);
    await onStart?.(session.id);
    for (const end = Date.now() + SESSION_TIMEOUT_MS; ; ) {
      const row = await agents.get(session.id);
      if (!isActive(row.status)) {
        if (row.status === 'completed') return row;
        // "exited with code 1" says nothing; the tail of the command's own output is the real reason.
        const out = await db.select({ data: schema.agentEvents.data }).from(schema.agentEvents)
          .where(and(eq(schema.agentEvents.sessionId, session.id), inArray(schema.agentEvents.type, ['output', 'error'])))
          .orderBy(desc(schema.agentEvents.seq)).limit(8);
        const tail = out.reverse().map((e) => (e.data as { text?: string; message?: string }).text ?? (e.data as { message?: string }).message ?? '').join('').trim().slice(-700);
        throw new HttpError(502, `${label.toLowerCase()} ${row.status}${row.statusDetail ? ` (${row.statusDetail})` : ''}${tail ? `: ${tail}` : ''}`);
      }
      if (Date.now() > end) throw new HttpError(504, `${label.toLowerCase()} did not finish within ${SESSION_TIMEOUT_MS / 60_000} minutes`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** The whole deploy, start to finish. Never throws: every failure is recorded on the release. */
  async function execute(deploymentId: string, releaseId: string, userId: string | null) {
    let d = await get(deploymentId);
    const finish = async (ok: boolean, depStatus: Deployment['status'], detail: string | null, extra: Partial<typeof R.$inferInsert> = {}) => {
      await db.update(R).set({ status: ok ? 'succeeded' : 'failed', detail, finishedAt: new Date(), ...extra }).where(eq(R.id, releaseId));
      await setStatus(d.id, ok ? { status: depStatus, currentReleaseId: releaseId } : { status: depStatus });
      if (!ok) await alert(ctx, { level: 'error', title: `Deployment of ${d.name} failed`, body: detail ?? undefined, serverId: d.serverId, link: `deployment:${d.id}` });
      else await alert(ctx, { level: 'info', title: `${d.name} deployed`, serverId: d.serverId, link: `deployment:${d.id}` });
    };
    try {
      const [rel] = await db.update(R).set({ status: 'running' }).where(eq(R.id, releaseId)).returning();
      await setStatus(d.id, { status: 'deploying' });
      const { isRepo } = await hub.call(d.serverId, 'git.status', { cwd: d.workdir });
      if (rel!.version) {
        if (!isRepo) throw new Error('a version was requested but the working directory is not a git repository');
        await hub.call(d.serverId, 'git.checkout', { cwd: d.workdir, ref: rel!.version, create: false });
      }
      const attach = (sessionId: string) => db.update(R).set({ sessionId }).where(eq(R.id, releaseId)).then(() => dash.publish('deployments', { id: d.id }));
      if (d.buildCommand?.length) await runSession(d, 'Build', d.buildCommand, userId, attach);
      await runSession(d, 'Deploy', compose(d, 'up', '-d', '--build', '--remove-orphans'), userId, attach);
      const version = isRepo ? ((await hub.call(d.serverId, 'git.log', { cwd: d.workdir, limit: 1 }))[0]?.sha ?? null) : null;

      d = await get(d.id);
      if (!d.healthUrl) return await finish(true, 'healthy', 'Containers started. No health URL is configured, so health was not verified.', { version });
      let health: HttpCheck = { ok: false, status: null, ms: 0, error: 'not checked' };
      for (const end = Date.now() + HEALTH_WAIT_MS; ; ) {
        health = await hub.call(d.serverId, 'http.check', { url: d.healthUrl, timeoutMs: 5000 });
        if (health.ok || Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (health.ok) return await finish(true, 'healthy', `Healthy: HTTP ${health.status} in ${health.ms} ms`, { version, health });
      // The containers were replaced, so this release is what is running — and it is not healthy.
      await db.update(D).set({ currentReleaseId: releaseId }).where(eq(D.id, d.id));
      await finish(false, 'unhealthy', `Started, but the health check failed after ${HEALTH_WAIT_MS / 1000}s: ${health.error ?? `HTTP ${health.status}`}`, { version, health });
    } catch (err) {
      await finish(false, 'failed', err instanceof Error ? err.message : String(err)).catch((e) => ctx.log.error({ err: e, deploymentId }, 'could not record deployment failure'));
    }
  }

  /** Create a release and either start it or park it for an administrator's approval. */
  async function request(d: Deployment, opts: { version?: string | null; trigger: Release['trigger']; userId: string; canDeploy: boolean }) {
    if (!hub.isOnline(d.serverId)) throw new HttpError(503, 'the server is offline; it cannot be deployed to right now');
    const busy = await db.select({ id: R.id }).from(R).where(and(eq(R.deploymentId, d.id), eq(R.status, 'running')));
    if (busy.length) throw new HttpError(409, 'a deployment is already in progress');
    const [rel] = await db.insert(R).values({
      deploymentId: d.id, version: opts.version || null, trigger: opts.trigger, requestedBy: opts.userId,
      status: opts.canDeploy ? 'running' : 'pending_approval', approvedBy: opts.canDeploy ? opts.userId : null,
    }).returning();
    if (opts.canDeploy) {
      void execute(d.id, rel!.id, opts.userId);
    } else {
      await setStatus(d.id, { status: 'pending_approval' });
      await alert(ctx, { level: 'warning', title: `${d.name}: production deployment needs approval`, serverId: d.serverId, link: `deployment:${d.id}` });
    }
    return rel!;
  }

  async function decide(d: Deployment, releaseId: string, approve: boolean, userId: string) {
    const [rel] = await db.select().from(R).where(and(eq(R.id, releaseId), eq(R.deploymentId, d.id)));
    if (!rel) throw new HttpError(404, 'release not found');
    if (rel.status !== 'pending_approval') throw new HttpError(409, `this release is ${rel.status}, not waiting for approval`);
    if (!approve) {
      await db.update(R).set({ status: 'rejected', approvedBy: userId, finishedAt: new Date(), detail: 'Rejected by an administrator.' }).where(eq(R.id, rel.id));
      // back to whatever the last finished deploy left behind
      const [current] = d.currentReleaseId ? await db.select().from(R).where(eq(R.id, d.currentReleaseId)) : [];
      await setStatus(d.id, { status: current ? (current.status === 'succeeded' ? 'healthy' : 'unhealthy') : 'idle' });
      return;
    }
    if (!hub.isOnline(d.serverId)) throw new HttpError(503, 'the server is offline; approve again when it is back');
    await db.update(R).set({ approvedBy: userId }).where(eq(R.id, rel.id));
    void execute(d.id, rel.id, userId);
  }

  /** Live probe; also keeps the stored healthy/unhealthy status honest. */
  async function checkHealth(d: Deployment): Promise<HttpCheck> {
    if (!d.healthUrl) throw new HttpError(400, 'this deployment has no health URL');
    const health = await hub.call(d.serverId, 'http.check', { url: d.healthUrl, timeoutMs: 8000 });
    const next = health.ok ? 'healthy' : 'unhealthy';
    if ((d.status === 'healthy' || d.status === 'unhealthy') && d.status !== next) {
      await setStatus(d.id, { status: next });
      await alert(ctx, {
        level: health.ok ? 'info' : 'error', title: health.ok ? `${d.name} is healthy again` : `${d.name} is failing its health check`,
        body: health.ok ? undefined : (health.error ?? `HTTP ${health.status}`), serverId: d.serverId, link: `deployment:${d.id}`,
      });
    }
    return health;
  }

  const containers = async (d: Deployment): Promise<Container[]> =>
    (await hub.call(d.serverId, 'docker.list', {})).filter((c) => c.composeProject === composeProject(d));

  /** `compose stop` / `compose down` as a supervised session; resolves when it has finished. */
  const runCompose = (d: Deployment, label: string, userId: string, ...args: string[]) => runSession(d, label, compose(d, ...args), userId);

  // Deploys are orchestrated in this process and are not resumable.
  // shortcut: a deploy interrupted by an API restart is marked failed rather than resumed; move orchestration to a durable job if that matters.
  async function recoverInterrupted() {
    const stuck = await db.update(R).set({ status: 'failed', finishedAt: new Date(), detail: 'The control plane restarted mid-deploy; the outcome on the server is unknown. Check the containers and deploy again.' })
      .where(eq(R.status, 'running')).returning({ deploymentId: R.deploymentId });
    if (stuck.length) await db.update(D).set({ status: 'failed' }).where(inArray(D.id, stuck.map((s) => s.deploymentId)));
  }

  let timer: NodeJS.Timeout | undefined;
  function startMonitor() {
    timer = setInterval(() => {
      void (async () => {
        const rows = await db.select().from(D).where(and(isNotNull(D.healthUrl), inArray(D.status, ['healthy', 'unhealthy'])));
        for (const d of rows) if (hub.isOnline(d.serverId)) await checkHealth(d).catch((err) => ctx.log.warn({ err, deploymentId: d.id }, 'health monitor check failed'));
      })().catch((err) => ctx.log.error({ err }, 'health monitor tick failed'));
    }, MONITOR_MS);
    timer.unref();
  }
  const stopMonitor = () => clearInterval(timer);

  return { get, envOf, request, decide, checkHealth, containers, runCompose, recoverInterrupted, startMonitor, stopMonitor };
}
export type DeploymentService = ReturnType<typeof deploymentService>;
