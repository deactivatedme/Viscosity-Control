import { eq, sql } from 'drizzle-orm';
import type { AgentEventEnvelope } from '@viscosity/protocol';
import { alert, audit, HttpError, type Ctx } from '../context';
import { schema } from '../db';
import { expireApprovals, isOffline, isTerminal, reconcile, recordApprovalRequest, recordApprovalResolved } from './sessions';

const A = schema.agentSessions;
type Row = typeof A.$inferSelect;
export interface AgentInput {
  serverId: string; name?: string; provider: Row['provider']; model?: string; cwd: string; permissionMode: Row['permissionMode'];
  worktreeBranch?: string; credentialId?: string; command?: string[]; prompt: string;
}
const CRED_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', github: 'GITHUB_TOKEN' } as const;

export function agentService(ctx: Ctx) {
  const { db, hub, dash, box } = ctx;

  async function get(id: string): Promise<Row> {
    const [row] = await db.select().from(A).where(eq(A.id, id));
    if (!row) throw new HttpError(404, 'agent not found');
    return row;
  }

  /** Ask the worker to run `prompt` in this session. The worker's status events drive the row from here. */
  async function launch(row: Row, prompt: string, resume: string | null) {
    const env: Record<string, string> = {};
    if (row.credentialId) {
      const [cred] = await db.select().from(schema.credentials).where(eq(schema.credentials.id, row.credentialId));
      if (cred) env[CRED_ENV[cred.kind]] = box.decrypt(cred.secretEnc);
    }
    await db.update(A).set({ task: prompt, statusDetail: null }).where(eq(A.id, row.id));
    try {
      await hub.call(row.serverId, 'agent.start', {
        sessionId: row.id, provider: row.provider, cwd: row.worktreePath ?? row.cwd, prompt,
        model: row.model ?? undefined, permissionMode: row.permissionMode,
        // once the worktree exists the session simply runs inside it
        worktreeBranch: row.worktreePath ? undefined : (row.worktreeBranch ?? undefined),
        resume: resume ?? undefined, env, command: row.command ?? undefined,
      });
    } catch (err) {
      if (isOffline(err) && row.status === 'queued') {
        await db.update(A).set({ statusDetail: 'Waiting for the server to come online.' }).where(eq(A.id, row.id));
        return;
      }
      if (row.status === 'queued') {
        const message = err instanceof Error ? err.message : String(err);
        await db.update(A).set({ status: 'failed', statusDetail: message, endedAt: new Date() }).where(eq(A.id, row.id));
        dash.publish('agents', { id: row.id, status: 'failed' });
      }
      throw err;
    }
  }

  async function ingest(serverId: string, env: AgentEventEnvelope) {
    const [row] = await db.select().from(A).where(eq(A.id, env.sessionId));
    if (!row || row.serverId !== serverId) {
      ctx.log.warn({ serverId, sessionId: env.sessionId }, 'agent event for a session this server does not own; dropped');
      return;
    }
    const inserted = await db.insert(schema.agentEvents)
      .values({ sessionId: env.sessionId, seq: env.seq, ts: new Date(env.ts), type: env.event.type, data: env.event })
      .onConflictDoNothing().returning({ seq: schema.agentEvents.seq });
    if (inserted.length === 0) return; // already have it (replay overlap)

    const ev = env.event;
    const patch: Record<string, unknown> = { lastSeq: sql`greatest(${A.lastSeq}, ${env.seq})` };
    if (ev.type === 'status') {
      patch.status = ev.status;
      patch.statusDetail = ev.detail ?? null;
      if (ev.status === 'starting') Object.assign(patch, { startedAt: new Date(env.ts), endedAt: null });
      if (isTerminal(ev.status)) {
        patch.endedAt = new Date(env.ts);
        await expireApprovals(ctx, row.id);
        if (ev.status === 'failed') await alert(ctx, { level: 'error', title: `${row.name} failed`, body: ev.detail, serverId, link: `agent:${row.id}` });
        if (ev.status === 'completed') await alert(ctx, { level: 'info', title: `${row.name} finished`, serverId, link: `agent:${row.id}` });
      }
    } else if (ev.type === 'usage') {
      patch.inputTokens = sql`${A.inputTokens} + ${Math.round(ev.inputTokens)}`;
      patch.outputTokens = sql`${A.outputTokens} + ${Math.round(ev.outputTokens)}`;
      if (ev.costUsd !== null) patch.costUsd = sql`coalesce(${A.costUsd}, 0) + ${ev.costUsd}`;
    } else if (ev.type === 'result') {
      if (ev.providerSessionId) patch.providerSessionId = ev.providerSessionId;
      if (ev.worktree) patch.worktreePath = ev.worktree;
    } else if (ev.type === 'approval_request') {
      await recordApprovalRequest(ctx, {
        kind: 'agent', sessionId: row.id, serverId, approvalId: ev.approvalId, name: row.name,
        summary: `${ev.tool}: ${JSON.stringify(ev.input).slice(0, 300)}`, payload: { tool: ev.tool, input: ev.input },
      });
    } else if (ev.type === 'approval_resolved') {
      await recordApprovalResolved(ctx, row.id, ev.approvalId, ev.decision);
    }
    await db.update(A).set(patch).where(eq(A.id, row.id));
    dash.publish(`agent:${row.id}`, env);
    if (ev.type === 'status') dash.publish('agents', { id: row.id, status: ev.status });
  }

  hub.on('agent.event', ingest);
  hub.on('hello', (serverId, hello) =>
    reconcile(ctx, 'agent', serverId, hello.agents, async (id) => {
      const row = await get(id);
      await launch(row, row.task, null).catch((err) => ctx.log.error({ err, id }, 'failed to start queued agent'));
    }));

  /** Create a session and start it (it stays queued if the server is offline). Used by the API route and the scheduler. */
  async function create(input: AgentInput, userId: string | null, source = 'user'): Promise<Row> {
    if (input.provider === 'custom' && !input.command?.length) throw new HttpError(400, 'a custom agent needs a command');
    if (input.provider !== 'claude' && input.permissionMode === 'ask')
      throw new HttpError(400, `${input.provider} agents cannot ask for approvals; choose another permission mode`);
    const [server] = await db.select().from(schema.servers).where(eq(schema.servers.id, input.serverId));
    if (!server) throw new HttpError(404, 'server not found');
    const [row] = await db.insert(A).values({
      serverId: input.serverId, name: input.name || input.prompt.slice(0, 60), provider: input.provider, model: input.model || null,
      cwd: input.cwd, permissionMode: input.permissionMode, worktreeBranch: input.worktreeBranch ?? null, command: input.command ?? null,
      credentialId: input.credentialId ?? null, task: input.prompt, createdBy: userId,
    }).returning();
    await audit(ctx, null, 'agent.create', row!.name, { serverId: input.serverId, detail: { provider: input.provider, cwd: input.cwd, permissionMode: input.permissionMode, source }, userId });
    dash.publish('agents', { id: row!.id, status: 'queued' });
    await launch(row!, input.prompt, null);
    return get(row!.id);
  }

  return { get, launch, create };
}
export type AgentService = ReturnType<typeof agentService>;
