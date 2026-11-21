import { Cron } from 'croner';
import { and, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { alert, HttpError, type Ctx } from '../context';
import { schema } from '../db';
import type { AgentInput, AgentService } from './agents';
import type { BrowserInput, BrowserService } from './browser';
import { isActive } from './sessions';

const W = schema.workflows;
const R = schema.workflowRuns;
type Row = typeof W.$inferSelect;
const TICK_MS = 15_000;

/** Next firing after `from`, or null for manual-only workflows. Throws on an invalid expression/timezone. */
export function nextRun(schedule: string | null, timezone: string, from = new Date()): Date | null {
  if (!schedule) return null;
  if (schedule.trim().split(/\s+/).length !== 5) throw new HttpError(400, 'schedule must be a 5-field cron expression (minute hour day month weekday)');
  try {
    return new Cron(schedule, { timezone }).nextRun(from);
  } catch (err) {
    throw new HttpError(400, `invalid schedule: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Durable scheduler. Schedules live in Postgres (`next_run_at`), so nothing is lost
 * on restart: a firing missed while the API was down runs once at startup, then the
 * schedule continues from now. `FOR UPDATE SKIP LOCKED` + advancing `next_run_at`
 * inside the claim makes each slot fire at most once even with several API replicas.
 */
export function workflowService(ctx: Ctx, agents: AgentService, browsers: BrowserService) {
  const { db } = ctx;

  async function lastSessionActive(wf: Row): Promise<boolean> {
    const [last] = await db.select().from(R).where(and(eq(R.workflowId, wf.id), isNotNull(R.sessionId))).orderBy(desc(R.startedAt)).limit(1);
    if (!last?.sessionId) return false;
    const T = wf.kind === 'agent' ? schema.agentSessions : schema.browserSessions;
    const [s] = await db.select({ status: T.status }).from(T).where(eq(T.id, last.sessionId));
    return !!s && isActive(s.status);
  }

  async function run(wf: Row, trigger: 'schedule' | 'manual', userId: string | null) {
    // Overlap policy: never stack runs of the same workflow.
    if (await lastSessionActive(wf)) {
      const [r] = await db.insert(R).values({ workflowId: wf.id, trigger, status: 'skipped', detail: 'The previous run is still in progress.' }).returning();
      return r!;
    }
    try {
      const session = wf.kind === 'agent'
        ? await agents.create({ ...(wf.config as unknown as AgentInput), serverId: wf.serverId, name: wf.name }, userId, `workflow:${wf.id}`)
        : await browsers.create({ ...(wf.config as unknown as BrowserInput), serverId: wf.serverId, name: wf.name }, userId, `workflow:${wf.id}`);
      await db.update(W).set({ lastRunAt: new Date() }).where(eq(W.id, wf.id));
      const [r] = await db.insert(R).values({ workflowId: wf.id, trigger, status: 'started', sessionId: session.id }).returning();
      ctx.dash.publish('workflows', { id: wf.id });
      return r!;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const [r] = await db.insert(R).values({ workflowId: wf.id, trigger, status: 'failed', detail }).returning();
      await alert(ctx, { level: 'error', title: `Workflow "${wf.name}" could not start`, body: detail, serverId: wf.serverId });
      ctx.dash.publish('workflows', { id: wf.id });
      return r!;
    }
  }

  /** Claim every due workflow, advance its schedule, then start it. */
  async function tick(now = new Date()) {
    const due = await db.transaction(async (tx) => {
      const rows = await tx.select().from(W).where(and(eq(W.enabled, true), lte(W.nextRunAt, now))).for('update', { skipLocked: true });
      for (const wf of rows) {
        let next: Date | null = null;
        try {
          next = nextRun(wf.schedule, wf.timezone, now);
        } catch {
          // an expression that stopped parsing (e.g. after an upgrade) disables itself instead of spinning
        }
        await tx.update(W).set({ nextRunAt: next, enabled: next !== null }).where(eq(W.id, wf.id));
      }
      return rows;
    });
    for (const wf of due) await run(wf, 'schedule', wf.createdBy);
    return due.length;
  }

  let timer: NodeJS.Timeout | undefined;
  function start() {
    const loop = () => void tick().catch((err) => ctx.log.error({ err }, 'workflow scheduler tick failed'));
    loop();
    timer = setInterval(loop, TICK_MS);
    timer.unref();
  }
  const stop = () => clearInterval(timer);

  async function get(id: string): Promise<Row> {
    const [wf] = await db.select().from(W).where(eq(W.id, id));
    if (!wf) throw new HttpError(404, 'workflow not found');
    return wf;
  }

  /** Capture the configuration of a session that already ran as a reusable workflow. */
  async function configFrom(kind: 'agent' | 'browser', sessionId: string): Promise<{ serverId: string; config: Record<string, unknown> }> {
    if (kind === 'agent') {
      const a = await agents.get(sessionId);
      const config: Omit<AgentInput, 'serverId' | 'name'> = {
        provider: a.provider, model: a.model ?? undefined, cwd: a.cwd, permissionMode: a.permissionMode, worktreeBranch: a.worktreeBranch ?? undefined,
        credentialId: a.credentialId ?? undefined, command: a.command ?? undefined, prompt: a.task,
      };
      // An unattended run cannot wait on a human forever.
      if (config.permissionMode === 'ask') throw new HttpError(400, 'a scheduled agent cannot use the "ask" permission mode; start it once with another mode first');
      return { serverId: a.serverId, config };
    }
    const b = await browsers.get(sessionId);
    const config: Omit<BrowserInput, 'serverId' | 'name'> = {
      mode: b.mode, startUrl: b.startUrl ?? undefined, task: b.task ?? undefined, steps: (b.steps as unknown[] | null) ?? undefined,
      credentialId: b.credentialId ?? undefined, model: b.model ?? undefined,
    };
    return { serverId: b.serverId, config };
  }

  const runsOf = (id: string) => db.select({
    id: R.id, trigger: R.trigger, status: R.status, sessionId: R.sessionId, detail: R.detail, startedAt: R.startedAt,
    // the linked session's own status is the outcome of a started run
    outcome: sql<string | null>`coalesce((select status from agent_sessions where id = ${R.sessionId}), (select status from browser_sessions where id = ${R.sessionId}))`,
  }).from(R).where(eq(R.workflowId, id)).orderBy(desc(R.startedAt)).limit(50);

  return { start, stop, tick, run, get, configFrom, runsOf };
}
export type WorkflowService = ReturnType<typeof workflowService>;
