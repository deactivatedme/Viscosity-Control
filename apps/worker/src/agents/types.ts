import type { AgentEvent, AgentStartParams } from '@viscosity/protocol';
import type { Decision } from '../sessions';

export interface RunContext {
  params: AgentStartParams;
  /** Guarded working directory (the worktree when isolation is on). */
  cwd: string;
  /** Child-process environment: base env + provider credentials. Never log it. */
  env: Record<string, string>;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
  /** Emits an approval request and blocks until the operator decides. */
  requestApproval(tool: string, input: unknown): Promise<Decision>;
  /** Record the provider-native session/thread id as soon as it is known, so a stopped run can be resumed. */
  setProviderSession(id: string): void;
}

export interface AdapterResult {
  ok: boolean;
  summary: string;
}

/** A provider adapter runs one turn to completion, translating provider output into AgentEvents. */
export type Adapter = (ctx: RunContext) => Promise<AdapterResult>;

export const MAX_OUTPUT = 20_000;
export const clip = (text: string): string => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]` : text);
