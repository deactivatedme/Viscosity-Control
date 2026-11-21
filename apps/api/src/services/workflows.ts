import { Cron } from 'croner';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { alert, HttpError, type AuthUser, type Ctx } from '../context';
import { schema } from '../db';
import type { AgentInput, AgentService } from './agents';
import type { BrowserInput, BrowserService } from './browser';
import { isActive } from './sessions';
import { failAttempt, isLive, LIVE, runStatus, validateSteps, type RunState, type Step, type StepState } from './workflow-steps';

const W = schema.workflows;
const R = schema.workflowRuns;
type Row = typeof W.$inferSelect;
type Run = typeof R.$inferSelect;
const TICK_MS = 5_000;
/** How long a claimed attempt may exist without its session before the engine (re)creates it. Longer than a worker RPC timeout. */
const CLAIM_GRACE_MS = 45_000;
/** The worker enforces the step timeout itself; the engine steps in slightly later (offline server, queued session). */
const TIMEOUT_SLACK_MS = 5_000;
const BAD = ['failed', 'lost', 'stopped'];

export interface StepInput {
  id?: string; name: string; from?: { kind: 'agent' | 'browser'; sessionId: string } | { approval: true };
  dependsOn: string[]; retries: number; timeoutSec?: number;
}

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

/** Steps of a workflow; rows created before multi-step support are a single step built from kind/config. */
export const definitionOf = (wf: Row): Step[] =>
  (wf.steps as Step[] | null) ?? [{ id: 'main', name: wf.name, kind: wf.kind, config: wf.config, serverId: wf.serverId, dependsOn: [], retries: 0 }];

/**
 * Durable scheduler + orchestration engine.
 *
 * Schedules live in Postgres (`next_run_at`): a firing missed while the API was down runs once at
 * startup, and `FOR UPDATE SKIP LOCKED` makes each slot fire at most once across replicas.
 *
 * A run's whole progress lives in `workflow_runs.state`. `advance` is the only thing that moves a
 * run forward; it is safe to call at any time, from any replica, any number of times:
 *   1. under a row lock it settles finished sessions, applies retries/timeouts/failure propagation
 *      and *claims* the steps that can start — each claim records the id its session will have;
 *   2. after committing, it creates those sessions with exactly those ids.
 * Because the id is durable before the session exists, a crash between 1 and 2 (or two racing
 * passes) can never start a step twice: creating the same id again is a primary-key conflict.
 */
export function workflowService(ctx: Ctx, agents: AgentService, browsers: BrowserService) {
  const { db, hub, dash } = ctx;
  const publish = (run: Pick<Run, 'id' | 'workflowId'>) => dash.publish('workflows', { id: run.workflowId, runId: run.id });
  const sessionTable = (kind: Step['kind']) => (kind === 'agent' ? schema.agentSessions : schema.browserSessions);

  // ── definitions ──

  async function get(id: string): Promise<Row> {
    const [wf] = await db.select().from(W).where(eq(W.id, id));
    if (!wf) throw new HttpError(404, 'workflow not found');
    return wf;
  }

  /** Capture the configuration of a session that already ran as a reusable step. */
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

  /** Turn editor input into validated steps. A step without `from` keeps the source of the existing step with the same id. */
  async function resolveSteps(input: StepInput[], existing: Step[] = []): Promise<Step[]> {
    const steps: Step[] = [];
    for (const s of input) {
      const id = s.id ?? randomUUID().slice(0, 8);
      const base = { id, name: s.name, dependsOn: [...new Set(s.dependsOn)], retries: s.retries, timeoutSec: s.timeoutSec };
      const kept = existing.find((e) => e.id === id);
      if (s.from && 'approval' in s.from) steps.push({ ...base, kind: 'approval', config: {}, serverId: '', retries: 0, timeoutSec: undefined });
      else if (s.from) steps.push({ ...base, kind: s.from.kind, ...(await configFrom(s.from.kind, s.from.sessionId)) });
      else if (kept) steps.push({ ...base, kind: kept.kind, config: kept.config, serverId: kept.serverId, ...(kept.kind === 'approval' ? { retries: 0, timeoutSec: undefined } : {}) });
      else throw new HttpError(400, `step "${s.name}" needs a past run to copy, or must be an approval gate`);
    }
    validateSteps(steps);
    // gates have no server of their own; their approval record is filed under the workflow's first server
    const home = steps.find((s) => s.kind !== 'approval')!.serverId;
    return steps.map((s) => (s.kind === 'approval' ? { ...s, serverId: home } : s));
  }

  // ── runs ──

  async function getRun(runId: string): Promise<Run> {
    const [run] = await db.select().from(R).where(eq(R.id, runId));
    if (!run) throw new HttpError(404, 'workflow run not found');
    return run;
  }
  const runsOf = (id: string) => db.select().from(R).where(eq(R.workflowId, id)).orderBy(desc(R.startedAt)).limit(50);

  /** Start a run (or record that it was skipped because the previous one is still going). */
  async function run(wf: Row, trigger: 'schedule' | 'manual', userId: string | null): Promise<Run> {
    const created = await db.transaction(async (tx) => {
      // Lock the workflow so a manual run and a scheduled firing cannot both pass the overlap check.
      await tx.select({ id: W.id }).from(W).where(eq(W.id, wf.id)).for('update');
      const [busy] = await tx.select({ id: R.id }).from(R).where(and(eq(R.workflowId, wf.id), inArray(R.status, [...LIVE]))).limit(1);
      if (busy) {
        const [r] = await tx.insert(R).values({ workflowId: wf.id, trigger, status: 'skipped', detail: 'The previous run is still in progress.', finishedAt: new Date() }).returning();
        return r!;
      }
      const def = definitionOf(wf);
      const state: RunState = { def, name: wf.name, userId, steps: Object.fromEntries(def.map((s) => [s.id, { status: 'pending', attempts: 0, sessionIds: [] } satisfies StepState])) };
      await tx.update(W).set({ lastRunAt: new Date() }).where(eq(W.id, wf.id));
      const [r] = await tx.insert(R).values({ workflowId: wf.id, trigger, status: 'running', state: state as unknown as Record<string, unknown> }).returning();
      return r!;
    });
    if (created.status === 'running') await advance(created.id);
    else publish(created);
    return getRun(created.id);
  }

  /** Short human-readable outcome of a finished session. */
  async function summaryOf(kind: Step['kind'], sessionId: string, fallback: string | null): Promise<string> {
    let text: string | null | undefined;
    if (kind === 'agent') {
      const E = schema.agentEvents;
      const [ev] = await db.select({ data: E.data }).from(E).where(and(eq(E.sessionId, sessionId), eq(E.type, 'result'))).orderBy(desc(E.seq)).limit(1);
      text = (ev?.data as { summary?: string } | undefined)?.summary;
    } else {
      const [b] = await db.select({ result: schema.browserSessions.result }).from(schema.browserSessions).where(eq(schema.browserSessions.id, sessionId));
      text = (b?.result as { summary?: string } | null)?.summary;
    }
    return (text || fallback || '').slice(0, 300);
  }

  async function stopSession(kind: Step['kind'], sessionId: string): Promise<void> {
    if (kind === 'approval') return;
    const T = sessionTable(kind);
    const [s] = await db.select({ status: T.status, serverId: T.serverId }).from(T).where(eq(T.id, sessionId));
    if (!s || !isActive(s.status)) return;
    if (s.status === 'queued') {
      // never reached a worker: there is nothing to stop remotely
      await db.update(T).set({ status: 'stopped', statusDetail: 'Cancelled before it started.', endedAt: new Date() }).where(eq(T.id, sessionId));
      dash.publish(`${kind}s`, { id: sessionId, status: 'stopped' });
    } else {
      await hub.call(s.serverId, `${kind}.stop`, { sessionId });
    }
  }

  async function createSession(runId: string, state: RunState, step: Step, sessionId: string): Promise<void> {
    const name = state.def.length > 1 ? `${state.name} · ${step.name}` : state.name;
    const extra = { serverId: step.serverId, name, id: sessionId, timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : undefined };
    if (step.kind === 'agent') await agents.create({ ...(step.config as unknown as AgentInput), ...extra }, state.userId, `workflow-run:${runId}`);
    else await browsers.create({ ...(step.config as unknown as BrowserInput), ...extra }, state.userId, `workflow-run:${runId}`);
  }

  /**
   * Lock a live run, let `fn` change its state, persist the result and tell the dashboard.
   * Returns the run as it is afterwards, or null if it is not live (finished, cancelled, or gone).
   */
  async function mutate(runId: string, fn: (state: RunState, run: Run, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<Partial<Run> | void>): Promise<Run | null> {
    let changed = false;
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(R).where(eq(R.id, runId)).for('update');
      if (!current || !isLive(current.status) || !current.state) return null;
      const state = structuredClone(current.state) as unknown as RunState;
      const extra = (await fn(state, current, tx)) ?? {};
      // A failed step fails the run: nothing new starts, gates are withdrawn, what is already running may finish.
      const failed = state.def.find((s) => state.steps[s.id]!.status === 'failed');
      if (failed) {
        const now = new Date();
        for (const st of Object.values(state.steps)) {
          if (st.status === 'pending' || st.status === 'waiting_approval') Object.assign(st, { status: 'skipped', finishedAt: now.toISOString(), result: `Skipped because "${failed.name}" failed.` });
        }
        await tx.update(schema.approvals).set({ status: 'expired', decidedAt: now })
          .where(and(eq(schema.approvals.sessionId, runId), eq(schema.approvals.kind, 'workflow'), eq(schema.approvals.status, 'pending')));
      }
      const status = extra.status ?? runStatus(state);
      changed = status !== current.status || JSON.stringify(state) !== JSON.stringify(current.state) || Object.keys(extra).length > 0;
      if (!changed) return current;
      const [row] = await tx.update(R).set({
        state: state as unknown as Record<string, unknown>, status,
        finishedAt: isLive(status) ? null : new Date(),
        detail: status === 'failed' && failed ? `${failed.name}: ${state.steps[failed.id]!.result ?? 'failed'}` : current.detail,
        ...extra,
      }).where(eq(R.id, runId)).returning();
      return row!;
    });
    if (updated && changed) {
      publish(updated);
      if (updated.status === 'failed') await alert(ctx, { level: 'error', title: `Workflow "${(updated.state as unknown as RunState).name}" failed`, body: updated.detail ?? undefined });
    }
    return updated;
  }

  /** Move one run as far as it can go right now. Idempotent and safe to race. */
  async function advance(runId: string): Promise<void> {
    const starts: { step: Step; sessionId: string }[] = [];
    const stops: { kind: Step['kind']; sessionId: string }[] = [];
    const gates: Step[] = [];
    let snapshot: RunState | undefined;

    const run = await mutate(runId, async (state, current, tx) => {
      const now = new Date();

      // 1. settle running steps from the sessions that carry them
      for (const step of state.def) {
        const st = state.steps[step.id]!;
        if (st.status !== 'running') continue;
        const sessionId = st.sessionIds.at(-1)!;
        const T = sessionTable(step.kind);
        const [session] = await tx.select({ status: T.status, detail: T.statusDetail }).from(T).where(eq(T.id, sessionId));
        const age = now.getTime() - new Date(st.claimedAt ?? 0).getTime();
        if (!session) {
          // claimed but never created: the process died in between (or creation is still in flight elsewhere)
          if (age > CLAIM_GRACE_MS) {
            st.claimedAt = now.toISOString();
            starts.push({ step, sessionId });
          }
        } else if (session.status === 'completed') {
          st.status = 'succeeded';
          st.finishedAt = now.toISOString();
          st.result = await summaryOf(step.kind, sessionId, session.detail);
        } else if (BAD.includes(session.status)) {
          failAttempt(step, st, await summaryOf(step.kind, sessionId, session.detail) || session.status, now);
        } else if (step.timeoutSec && age > step.timeoutSec * 1000 + TIMEOUT_SLACK_MS) {
          stops.push({ kind: step.kind, sessionId });
          failAttempt(step, st, `timed out after ${step.timeoutSec}s`, now);
        }
      }

      // 2. claim every step whose dependencies have all succeeded (independent steps start together) — unless the run has failed
      if (!state.def.some((s) => state.steps[s.id]!.status === 'failed')) {
        for (const step of state.def) {
          const st = state.steps[step.id]!;
          if (st.status !== 'pending' || !step.dependsOn.every((d) => state.steps[d]?.status === 'succeeded')) continue;
          st.startedAt ??= now.toISOString();
          if (step.kind === 'approval') {
            st.status = 'waiting_approval';
            await tx.insert(schema.approvals).values({
              kind: 'workflow', sessionId: runId, serverId: step.serverId, approvalId: step.id,
              summary: `Workflow "${state.name}" is waiting at "${step.name}"`, payload: { workflowId: current.workflowId, step: step.name },
            }).onConflictDoNothing();
            gates.push(step);
          } else {
            const sessionId = randomUUID();
            st.status = 'running';
            st.attempts += 1;
            st.sessionIds.push(sessionId);
            st.claimedAt = now.toISOString();
            starts.push({ step, sessionId });
          }
        }
      }
      snapshot = state;
      // the run's own session column points at the first session, which is all a one-step workflow has
      return current.sessionId ? undefined : { sessionId: Object.values(state.steps).find((s) => s.sessionIds[0])?.sessionIds[0] ?? null };
    });
    if (!run || !snapshot) return;

    for (const s of stops) await stopSession(s.kind, s.sessionId).catch((err) => ctx.log.warn({ err, runId }, 'could not stop a timed-out workflow session'));
    for (const gate of gates) await alert(ctx, { level: 'warning', title: `Workflow "${snapshot.name}" needs approval`, body: gate.name, serverId: gate.serverId });
    if (gates.length) dash.publish('approvals', { sessionId: runId });

    let again = false;
    await Promise.all(starts.map(async ({ step, sessionId }) => {
      try {
        await createSession(runId, snapshot!, step, sessionId);
      } catch (err) {
        again = true;
        // If the session row exists (a racing pass created it, or its launch failed and marked it), its status tells the story.
        const T = sessionTable(step.kind);
        const [exists] = await db.select({ id: T.id }).from(T).where(eq(T.id, sessionId));
        if (exists) return;
        const message = err instanceof Error ? err.message : String(err);
        await mutate(runId, async (state) => {
          const st = state.steps[step.id]!;
          if (st.status === 'running' && st.sessionIds.at(-1) === sessionId) failAttempt(step, st, message, new Date());
        });
      }
    }));

    if (again) await advance(runId);
  }

  // Coalesce bursts: one pass at a time, and one more if anything asked meanwhile.
  let passing = false;
  let asked = false;
  async function advanceAll(): Promise<void> {
    if (passing) return void (asked = true);
    passing = true;
    try {
      do {
        asked = false;
        // shortcut: every live run is re-examined on each trigger; index runs by session id once there are thousands of live runs
        const live = await db.select({ id: R.id }).from(R).where(inArray(R.status, [...LIVE]));
        for (const r of live) await advance(r.id).catch((err) => ctx.log.error({ err, runId: r.id }, 'workflow advance failed'));
      } while (asked);
    } finally {
      passing = false;
    }
  }

  async function decide(runId: string, stepId: string, decision: 'allow' | 'deny', user: AuthUser): Promise<Run> {
    const updated = await mutate(runId, async (state, _run, tx) => {
      const st = state.steps[stepId];
      if (!st || st.status !== 'waiting_approval') throw new HttpError(409, 'this step is not waiting for approval');
      st.status = decision === 'allow' ? 'succeeded' : 'failed';
      st.finishedAt = new Date().toISOString();
      st.result = `${decision === 'allow' ? 'Approved' : 'Denied'} by ${user.email}`;
      await tx.update(schema.approvals).set({ status: decision === 'allow' ? 'allowed' : 'denied', decidedBy: user.id, decidedAt: new Date() })
        .where(and(eq(schema.approvals.sessionId, runId), eq(schema.approvals.approvalId, stepId)));
    });
    if (!updated) throw new HttpError(409, 'this run is no longer active');
    dash.publish('approvals', { sessionId: runId });
    await advance(runId);
    return getRun(runId);
  }

  async function cancel(runId: string): Promise<Run> {
    const active: { kind: Step['kind']; sessionId: string }[] = [];
    const updated = await mutate(runId, async (state, _run, tx) => {
      const now = new Date().toISOString();
      for (const step of state.def) {
        const st = state.steps[step.id]!;
        if (st.status === 'running') active.push({ kind: step.kind, sessionId: st.sessionIds.at(-1)! });
        if (['pending', 'running', 'waiting_approval'].includes(st.status)) Object.assign(st, { status: 'cancelled', finishedAt: now });
      }
      await tx.update(schema.approvals).set({ status: 'expired', decidedAt: new Date() })
        .where(and(eq(schema.approvals.sessionId, runId), eq(schema.approvals.kind, 'workflow'), eq(schema.approvals.status, 'pending')));
      return { status: 'cancelled' as const };
    });
    if (!updated) throw new HttpError(409, 'this run is no longer active');
    // The run is cancelled either way; say so honestly if a session could not be told to stop.
    const problems: string[] = [];
    for (const s of active) await stopSession(s.kind, s.sessionId).catch((err) => problems.push(`${s.sessionId}: ${err instanceof Error ? err.message : String(err)}`));
    if (problems.length) await db.update(R).set({ detail: `Cancelled, but could not confirm stopping: ${problems.join('; ')}` }).where(eq(R.id, runId));
    dash.publish('approvals', { sessionId: runId });
    return getRun(runId);
  }

  // ── scheduling ──

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

  // A finished session is what usually unblocks a run; the timer covers timeouts, lost sessions and other replicas.
  const onStatus = (_serverId: string, env: { event: { type: string; status?: string } }) => {
    if (env.event.type === 'status' && ['completed', ...BAD].includes(env.event.status ?? '')) void advanceAll();
  };
  hub.on('agent.event', onStatus);
  hub.on('browser.event', onStatus);

  let timer: NodeJS.Timeout | undefined;
  function start() {
    const loop = () => void tick().then(advanceAll).catch((err) => ctx.log.error({ err }, 'workflow scheduler tick failed'));
    loop();
    timer = setInterval(loop, TICK_MS);
    timer.unref();
  }
  const stop = () => clearInterval(timer);

  return { start, stop, tick, run, advance, advanceAll, get, getRun, runsOf, configFrom, resolveSteps, decide, cancel };
}
export type WorkflowService = ReturnType<typeof workflowService>;
