import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AgentProvider, PermissionMode } from '@viscosity/protocol';
import { audit, HttpError, me, type Ctx } from '../context';
import { schema } from '../db';
import type { AgentService } from '../services/agents';
import { isActive } from '../services/sessions';

const Id = z.object({ id: z.string().uuid() });
const Create = z.object({
  serverId: z.string().uuid(),
  name: z.string().trim().max(80).optional(),
  provider: AgentProvider,
  model: z.string().trim().max(100).optional(),
  cwd: z.string().min(1).max(4096),
  permissionMode: PermissionMode,
  worktreeBranch: z.string().regex(/^[\w./-]+$/).max(120).optional(),
  credentialId: z.string().uuid().optional(),
  command: z.array(z.string().max(4096)).min(1).max(64).optional(),
  prompt: z.string().trim().min(1).max(100_000),
});

/** What each provider adapter genuinely supports; the dashboard hides controls that would be fake. */
export const PROVIDER_CAPS = {
  claude: { resume: true, approvals: true, pause: false },
  codex: { resume: true, approvals: false, pause: false },
  custom: { resume: false, approvals: false, pause: false },
} as const;

export function agentRoutes(app: FastifyInstance, ctx: Ctx, agents: AgentService) {
  const { db, hub } = ctx;
  const A = schema.agentSessions;
  const view = (r: typeof A.$inferSelect) => ({ ...r, serverOnline: hub.isOnline(r.serverId), capabilities: PROVIDER_CAPS[r.provider] });

  app.get('/api/agents', async (req) => {
    const q = z.object({ archived: z.enum(['0', '1']).default('0'), serverId: z.string().uuid().optional() }).parse(req.query);
    const rows = await db.select().from(A)
      .where(and(q.archived === '1' ? isNotNull(A.archivedAt) : isNull(A.archivedAt), q.serverId ? eq(A.serverId, q.serverId) : undefined))
      .orderBy(desc(A.createdAt)).limit(500);
    return rows.map(view);
  });

  app.post('/api/agents', async (req) => view(await agents.create(Create.parse(req.body), me(req).id)));

  app.get('/api/agents/:id', async (req) => {
    const row = await agents.get(Id.parse(req.params).id);
    const approvals = await db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.sessionId, row.id), eq(schema.approvals.status, 'pending')));
    return { ...view(row), approvals };
  });

  app.get('/api/agents/:id/events', async (req) => {
    const { id } = Id.parse(req.params);
    const q = z.object({ after: z.coerce.number().int().default(0), limit: z.coerce.number().int().min(1).max(2000).default(1000) }).parse(req.query);
    const E = schema.agentEvents;
    const rows = await db.select().from(E).where(and(eq(E.sessionId, id), gt(E.seq, q.after))).orderBy(asc(E.seq)).limit(q.limit);
    return rows.map((r) => ({ sessionId: r.sessionId, seq: r.seq, ts: r.ts.getTime(), event: r.data }));
  });

  app.post('/api/agents/:id/stop', async (req) => {
    const row = await agents.get(Id.parse(req.params).id);
    if (row.status === 'queued') {
      // never reached a worker: nothing to stop remotely
      await db.update(A).set({ status: 'stopped', statusDetail: 'Cancelled before it started.', endedAt: new Date() }).where(eq(A.id, row.id));
      ctx.dash.publish('agents', { id: row.id, status: 'stopped' });
    } else {
      if (!isActive(row.status)) throw new HttpError(409, `agent is already ${row.status}`);
      await hub.call(row.serverId, 'agent.stop', { sessionId: row.id }); // status changes when the worker confirms
    }
    await audit(ctx, req, 'agent.stop', row.name, { serverId: row.serverId });
    return { ok: true };
  });

  /** Follow-up message: resumes the provider session where supported. */
  app.post('/api/agents/:id/messages', async (req) => {
    const row = await agents.get(Id.parse(req.params).id);
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(100_000) }).parse(req.body);
    if (isActive(row.status)) throw new HttpError(409, 'the agent is still working; wait for it to finish or stop it first');
    if (!PROVIDER_CAPS[row.provider].resume) throw new HttpError(400, `${row.provider} agents cannot be resumed; use restart instead`);
    if (!row.providerSessionId) throw new HttpError(409, 'this session has no provider conversation to resume; use restart instead');
    await agents.launch(row, prompt, row.providerSessionId);
    await audit(ctx, req, 'agent.message', row.name, { serverId: row.serverId });
    return { ok: true };
  });

  /** Run the current task again from scratch (new provider conversation). */
  app.post('/api/agents/:id/restart', async (req) => {
    const row = await agents.get(Id.parse(req.params).id);
    if (isActive(row.status)) throw new HttpError(409, 'stop the agent before restarting it');
    await agents.launch(row, row.task, null);
    await audit(ctx, req, 'agent.restart', row.name, { serverId: row.serverId });
    return { ok: true };
  });

  app.post('/api/agents/:id/archive', async (req) => {
    const row = await agents.get(Id.parse(req.params).id);
    const { archived } = z.object({ archived: z.boolean().default(true) }).parse(req.body ?? {});
    if (archived && isActive(row.status)) throw new HttpError(409, 'stop the agent before archiving it');
    await db.update(A).set({ archivedAt: archived ? new Date() : null }).where(eq(A.id, row.id));
    await audit(ctx, req, archived ? 'agent.archive' : 'agent.unarchive', row.name, { serverId: row.serverId });
    ctx.dash.publish('agents', { id: row.id });
    return { ok: true };
  });

  app.post('/api/agents/:id/approvals/:approvalId', async (req) => {
    const { id, approvalId } = z.object({ id: z.string().uuid(), approvalId: z.string().max(200) }).parse(req.params);
    const body = z.object({ decision: z.enum(['allow', 'deny']), reason: z.string().max(1000).optional() }).parse(req.body);
    const row = await agents.get(id);
    await hub.call(row.serverId, 'agent.approve', { sessionId: id, approvalId, ...body });
    await db.update(schema.approvals).set({ decidedBy: me(req).id })
      .where(and(eq(schema.approvals.sessionId, id), eq(schema.approvals.approvalId, approvalId)));
    await audit(ctx, req, `agent.approval_${body.decision}`, row.name, { serverId: row.serverId, detail: { approvalId } });
    return { ok: true };
  });

  /** Working-tree changes in the agent's directory (or its worktree). */
  app.get('/api/agents/:id/git', async (req) => {
    const row = await agents.get(Id.parse(req.params).id);
    const cwd = row.worktreePath ?? row.cwd;
    const status = await hub.call(row.serverId, 'git.status', { cwd });
    if (!status.isRepo) return { status, diff: '', truncated: false };
    return { status, ...(await hub.call(row.serverId, 'git.diff', { cwd })) };
  });
}
