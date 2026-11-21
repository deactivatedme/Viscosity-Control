import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RpcError, type AgentEvent, type AgentProvider, type AgentStartParams } from '@viscosity/protocol';
import { OK, baseEnv, type Ctx, type Handlers } from '../context';
import { EventLog } from '../eventlog';
import { git, isRepo } from '../handlers/git';
import { errMessage, log } from '../log';
import { Sessions, type AbortReason, type Run } from '../sessions';
import { runClaude } from './claude';
import { runCodex } from './codex';
import { runCustom } from './custom';
import type { Adapter } from './types';

const ADAPTERS: Record<AgentProvider, Adapter> = { claude: runClaude, codex: runCodex, custom: runCustom };
/** Host-level provider settings the operator may have put in the worker's own environment. */
const PASSTHROUGH: Record<AgentProvider, RegExp | undefined> = { claude: /^ANTHROPIC_/, codex: /^(OPENAI|CODEX)_/, custom: undefined };

export interface AgentManager {
  handlers: Pick<Handlers, 'agent.start' | 'agent.stop' | 'agent.approve' | 'agent.replay'>;
  sessions: Sessions<AgentEvent>;
}

export function createAgentManager(ctx: Ctx): AgentManager {
  const sessions = new Sessions<AgentEvent>(new EventLog(join(ctx.config.dataDir, 'agents')), (envelope) => ctx.emit('agent.event', envelope));

  /** Creates (or reuses, on follow-up runs) a git worktree so parallel agents do not share a checkout. */
  async function ensureWorktree(cwd: string, sessionId: string, branch: string): Promise<string> {
    if (!(await isRepo(cwd))) throw new RpcError('invalid', 'worktree isolation requires the working directory to be a git repository');
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    // Prefer a sibling of the repository; fall back to the first root when the repository is itself a root.
    const candidates = [join(dirname(top), '.viscosity-worktrees', sessionId), join(ctx.config.roots[0]!, '.viscosity-worktrees', sessionId)];
    let dir: string | null = null;
    for (const candidate of candidates) {
      dir = await ctx.guard(candidate).catch(() => null);
      if (dir) break;
    }
    if (!dir) throw new RpcError('forbidden', 'no location inside the allowed roots for a worktree');
    if (existsSync(dir)) return dir;
    await mkdir(dirname(dir), { recursive: true });
    const exists = await git(top, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    await git(top, ['worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir])], 120_000);
    return dir;
  }

  async function execute(params: AgentStartParams, cwd: string, worktree: string | null, run: Run): Promise<void> {
    const id = params.sessionId;
    const emit = (event: AgentEvent): void => sessions.emit(id, event);
    const started = Date.now();
    let providerSessionId = params.resume ?? null;
    const finish = (ok: boolean, summary: string, status: 'completed' | 'failed' | 'stopped'): void => {
      emit({ type: 'result', ok, summary, durationMs: Date.now() - started, providerSessionId, worktree });
      emit({ type: 'status', status });
    };
    emit({ type: 'user', text: params.prompt });
    emit({ type: 'status', status: 'starting' });
    try {
      const result = await ADAPTERS[params.provider]({
        params,
        cwd,
        env: { ...baseEnv(PASSTHROUGH[params.provider]), ...params.env },
        signal: run.signal,
        emit,
        setProviderSession: (sid) => (providerSessionId = sid),
        requestApproval: async (tool, input) => {
          const approvalId = randomUUID();
          emit({ type: 'approval_request', approvalId, tool, input });
          emit({ type: 'status', status: 'waiting_approval' });
          const decision = await run.waitApproval(approvalId);
          emit({ type: 'approval_resolved', approvalId, ...decision });
          emit({ type: 'status', status: 'running' });
          return decision;
        },
      });
      if (run.signal.aborted) throw new Error('aborted');
      finish(result.ok, result.summary, result.ok ? 'completed' : 'failed');
    } catch (err) {
      const reason = run.signal.aborted ? (run.signal.reason as AbortReason) : null;
      if (reason === 'stopped') {
        finish(false, 'Stopped by the operator', 'stopped');
      } else {
        const message = reason === 'timeout' ? `Timed out after ${Math.round(params.timeoutMs / 1000)}s` : errMessage(err);
        log('warn', 'agent run failed', { sessionId: id, provider: params.provider, error: message });
        emit({ type: 'error', message });
        finish(false, message, 'failed');
      }
    } finally {
      sessions.end(id);
    }
  }

  return {
    sessions,
    handlers: {
      'agent.start': async (params) => {
        if (sessions.isActive(params.sessionId)) throw new RpcError('invalid', 'session is already running');
        if (params.provider === 'custom' && !params.command?.length) throw new RpcError('invalid', 'provider "custom" requires a command');
        let cwd = await ctx.guard(params.cwd);
        if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new RpcError('invalid', `working directory does not exist: ${params.cwd}`);
        let worktree: string | null = null;
        if (params.worktreeBranch) worktree = cwd = await ensureWorktree(cwd, params.sessionId, params.worktreeBranch);
        void execute(params, cwd, worktree, sessions.begin(params.sessionId, params.timeoutMs));
        return OK;
      },
      'agent.stop': async ({ sessionId }) => {
        sessions.stop(sessionId);
        return OK;
      },
      'agent.approve': async ({ sessionId, approvalId, decision, reason }) => {
        sessions.approve(sessionId, approvalId, { decision, reason });
        return OK;
      },
      'agent.replay': ({ sessionId, afterSeq }) => sessions.replay(sessionId, afterSeq),
    },
  };
}
