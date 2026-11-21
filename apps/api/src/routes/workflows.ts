import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, me, type Ctx } from '../context';
import { schema } from '../db';
import { nextRun, type WorkflowService } from '../services/workflows';

const Id = z.object({ id: z.string().uuid() });
const Schedule = z.string().trim().max(120).nullable();
const Timezone = z.string().trim().max(64).default('UTC');

export function workflowRoutes(app: FastifyInstance, ctx: Ctx, workflows: WorkflowService) {
  const { db } = ctx;
  const W = schema.workflows;

  app.get('/api/workflows', async () => {
    const rows = await db.select().from(W).orderBy(desc(W.createdAt));
    return Promise.all(rows.map(async (wf) => ({ ...wf, lastRun: (await workflows.runsOf(wf.id))[0] ?? null })));
  });

  /** Create from a session that already ran: its exact configuration becomes the template. */
  app.post('/api/workflows', async (req) => {
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      from: z.object({ kind: z.enum(['agent', 'browser']), sessionId: z.string().uuid() }),
      schedule: Schedule.default(null),
      timezone: Timezone,
    }).parse(req.body);
    const { serverId, config } = await workflows.configFrom(body.from.kind, body.from.sessionId);
    const schedule = body.schedule || null;
    const [wf] = await db.insert(W).values({
      name: body.name, kind: body.from.kind, serverId, config, schedule, timezone: body.timezone,
      nextRunAt: nextRun(schedule, body.timezone), createdBy: me(req).id,
    }).returning();
    await audit(ctx, req, 'workflow.create', wf!.name, { serverId, detail: { schedule, kind: wf!.kind } });
    return wf;
  });

  app.patch('/api/workflows/:id', async (req) => {
    const wf = await workflows.get(Id.parse(req.params).id);
    const body = z.object({ name: z.string().trim().min(1).max(80).optional(), schedule: Schedule.optional(), timezone: Timezone.optional(), enabled: z.boolean().optional() }).parse(req.body);
    const schedule = body.schedule === undefined ? wf.schedule : body.schedule || null;
    const timezone = body.timezone ?? wf.timezone;
    const enabled = body.enabled ?? wf.enabled;
    const [updated] = await db.update(W).set({
      name: body.name ?? wf.name, schedule, timezone, enabled,
      // re-enabling or rescheduling always computes from now, so nothing "catches up" unexpectedly
      nextRunAt: enabled ? nextRun(schedule, timezone) : null,
    }).where(eq(W.id, wf.id)).returning();
    await audit(ctx, req, 'workflow.update', wf.name, { serverId: wf.serverId, detail: body });
    return updated;
  });

  app.delete('/api/workflows/:id', async (req) => {
    const wf = await workflows.get(Id.parse(req.params).id);
    await db.delete(W).where(eq(W.id, wf.id));
    await audit(ctx, req, 'workflow.delete', wf.name, { serverId: wf.serverId });
    return { ok: true };
  });

  app.post('/api/workflows/:id/run', async (req) => {
    const wf = await workflows.get(Id.parse(req.params).id);
    const run = await workflows.run(wf, 'manual', me(req).id);
    await audit(ctx, req, 'workflow.run', wf.name, { serverId: wf.serverId, detail: { status: run.status } });
    return run;
  });

  app.get('/api/workflows/:id/runs', async (req) => workflows.runsOf(Id.parse(req.params).id));
}
