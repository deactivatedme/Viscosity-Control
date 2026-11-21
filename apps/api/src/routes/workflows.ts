import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, HttpError, me, type Ctx } from '../context';
import { schema } from '../db';
import { definitionOf, nextRun, type WorkflowService } from '../services/workflows';

const Id = z.object({ id: z.string().uuid() });
const RunId = z.object({ runId: z.string().uuid() });
const Schedule = z.string().trim().max(120).nullable();
const Timezone = z.string().trim().max(64).default('UTC');
const From = z.object({ kind: z.enum(['agent', 'browser']), sessionId: z.string().uuid() });
const StepIn = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/).optional(),
  name: z.string().trim().min(1).max(80),
  /** Copy a past session, or be an approval gate. Omit to keep the existing step with this id (edits). */
  from: z.union([From, z.object({ approval: z.literal(true) })]).optional(),
  dependsOn: z.array(z.string().max(40)).max(30).default([]),
  retries: z.number().int().min(0).max(5).default(0),
  timeoutSec: z.number().int().min(1).max(86_400).optional(),
});
const Steps = z.array(StepIn).min(1).max(30);

export function workflowRoutes(app: FastifyInstance, ctx: Ctx, workflows: WorkflowService) {
  const { db } = ctx;
  const W = schema.workflows;
  const view = (wf: typeof W.$inferSelect) => ({ ...wf, steps: definitionOf(wf) });

  app.get('/api/workflows', async () => {
    const rows = await db.select().from(W).orderBy(desc(W.createdAt));
    return Promise.all(rows.map(async (wf) => ({ ...view(wf), lastRun: (await workflows.runsOf(wf.id))[0] ?? null })));
  });

  /**
   * Create a workflow. Either `from` (one past session becomes the single step) or `steps`
   * (a dependency graph of past sessions and approval gates).
   */
  app.post('/api/workflows', async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), from: From.optional(), steps: Steps.optional(), schedule: Schedule.default(null), timezone: Timezone }).parse(req.body);
    if (!body.from === !body.steps) throw new HttpError(400, 'provide either "from" (one past run) or "steps"');
    const steps = await workflows.resolveSteps(body.steps ?? [{ id: 'main', name: body.name, from: body.from, dependsOn: [], retries: 0 }]);
    const first = steps.find((s) => s.kind !== 'approval')!;
    const schedule = body.schedule || null;
    const [wf] = await db.insert(W).values({
      name: body.name, kind: first.kind as 'agent' | 'browser', serverId: first.serverId, config: first.config, steps: body.steps ? steps : null,
      schedule, timezone: body.timezone, nextRunAt: nextRun(schedule, body.timezone), createdBy: me(req).id,
    }).returning();
    await audit(ctx, req, 'workflow.create', wf!.name, { serverId: first.serverId, detail: { schedule, steps: steps.map((s) => ({ id: s.id, kind: s.kind, dependsOn: s.dependsOn })) } });
    ctx.dash.publish('workflows', { id: wf!.id });
    return view(wf!);
  });

  app.patch('/api/workflows/:id', async (req) => {
    const wf = await workflows.get(Id.parse(req.params).id);
    const body = z.object({ name: z.string().trim().min(1).max(80).optional(), steps: Steps.optional(), schedule: Schedule.optional(), timezone: Timezone.optional(), enabled: z.boolean().optional() }).parse(req.body);
    const schedule = body.schedule === undefined ? wf.schedule : body.schedule || null;
    const timezone = body.timezone ?? wf.timezone;
    const enabled = body.enabled ?? wf.enabled;
    const steps = body.steps ? await workflows.resolveSteps(body.steps, definitionOf(wf)) : undefined;
    const first = steps?.find((s) => s.kind !== 'approval');
    const [updated] = await db.update(W).set({
      name: body.name ?? wf.name, schedule, timezone, enabled,
      ...(steps && first ? { steps, kind: first.kind as 'agent' | 'browser', serverId: first.serverId, config: first.config } : {}),
      // re-enabling or rescheduling always computes from now, so nothing "catches up" unexpectedly
      nextRunAt: enabled ? nextRun(schedule, timezone) : null,
    }).where(eq(W.id, wf.id)).returning();
    await audit(ctx, req, 'workflow.update', wf.name, { serverId: wf.serverId, detail: { ...body, steps: steps?.map((s) => ({ id: s.id, kind: s.kind, dependsOn: s.dependsOn })) } });
    ctx.dash.publish('workflows', { id: wf.id });
    return view(updated!);
  });

  app.delete('/api/workflows/:id', async (req) => {
    const wf = await workflows.get(Id.parse(req.params).id);
    // Runs are deleted with the workflow; do not leave their sessions running unsupervised.
    for (const run of await workflows.runsOf(wf.id)) if (['running', 'waiting_approval'].includes(run.status)) await workflows.cancel(run.id);
    await db.delete(W).where(eq(W.id, wf.id));
    await audit(ctx, req, 'workflow.delete', wf.name, { serverId: wf.serverId });
    ctx.dash.publish('workflows', { id: wf.id });
    return { ok: true };
  });

  app.post('/api/workflows/:id/run', async (req) => {
    const wf = await workflows.get(Id.parse(req.params).id);
    const run = await workflows.run(wf, 'manual', me(req).id);
    await audit(ctx, req, 'workflow.run', wf.name, { serverId: wf.serverId, detail: { runId: run.id, status: run.status } });
    return run;
  });

  app.get('/api/workflows/:id/runs', async (req) => workflows.runsOf(Id.parse(req.params).id));
  app.get('/api/workflows/runs/:runId', async (req) => workflows.getRun(RunId.parse(req.params).runId));

  app.post('/api/workflows/runs/:runId/cancel', async (req) => {
    const run = await workflows.cancel(RunId.parse(req.params).runId);
    await audit(ctx, req, 'workflow.cancel', run.workflowId, { detail: { runId: run.id } });
    return run;
  });

  app.post('/api/workflows/runs/:runId/approvals/:stepId', async (req) => {
    const { runId, stepId } = RunId.extend({ stepId: z.string().max(40) }).parse(req.params);
    const { decision } = z.object({ decision: z.enum(['allow', 'deny']) }).parse(req.body);
    const run = await workflows.decide(runId, stepId, decision, me(req));
    await audit(ctx, req, `workflow.approval_${decision}`, run.workflowId, { detail: { runId, stepId } });
    return run;
  });
}
