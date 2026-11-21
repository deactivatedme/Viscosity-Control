import { HttpError } from '../context';

/** One node of a workflow's dependency graph. `config` is a captured agent/browser creation payload. */
export interface Step {
  id: string;
  name: string;
  kind: 'agent' | 'browser' | 'approval';
  config: Record<string, unknown>;
  serverId: string;
  dependsOn: string[];
  /** Extra attempts after the first failure (0–5). */
  retries: number;
  timeoutSec?: number;
}

export type StepStatus = 'pending' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface StepState {
  status: StepStatus;
  attempts: number;
  /** One session per attempt; the id is chosen when the attempt is claimed, before the session exists. */
  sessionIds: string[];
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
}

/** Everything the engine needs to continue a run after a restart. Stored in workflow_runs.state. */
export interface RunState {
  /** The definition as it was when the run started; later edits to the workflow do not affect it. */
  def: Step[];
  name: string;
  userId: string | null;
  steps: Record<string, StepState>;
}

/** Run statuses the engine still acts on. */
export const LIVE = ['running', 'waiting_approval'] as const;
export const isLive = (status: string) => (LIVE as readonly string[]).includes(status);

export function validateSteps(steps: Step[]): void {
  if (steps.length === 0) throw new HttpError(400, 'a workflow needs at least one step');
  if (steps.length > 30) throw new HttpError(400, 'a workflow can have at most 30 steps');
  if (!steps.some((s) => s.kind !== 'approval')) throw new HttpError(400, 'a workflow needs at least one agent or browser step');
  const ids = new Set<string>();
  for (const s of steps) {
    if (!/^[\w-]{1,40}$/.test(s.id)) throw new HttpError(400, `invalid step id "${s.id}"`);
    if (ids.has(s.id)) throw new HttpError(400, `duplicate step id "${s.id}"`);
    ids.add(s.id);
    if (!Number.isInteger(s.retries) || s.retries < 0 || s.retries > 5) throw new HttpError(400, `step "${s.name}": retries must be between 0 and 5`);
    if (s.timeoutSec !== undefined && (!Number.isInteger(s.timeoutSec) || s.timeoutSec < 1 || s.timeoutSec > 86_400))
      throw new HttpError(400, `step "${s.name}": timeout must be between 1 second and 24 hours`);
    // an unattended run cannot wait on per-tool approvals; use an approval gate step instead
    if (s.kind === 'agent' && s.config.permissionMode === 'ask') throw new HttpError(400, `step "${s.name}": scheduled agents cannot use the "ask" permission mode`);
  }
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (d === s.id) throw new HttpError(400, `step "${s.name}" depends on itself`);
      if (!ids.has(d)) throw new HttpError(400, `step "${s.name}" depends on unknown step "${d}"`);
    }
  }
  // Kahn's algorithm: whatever cannot be ordered is part of a cycle.
  const done = new Set<string>();
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const s of steps) {
      if (!done.has(s.id) && s.dependsOn.every((d) => done.has(d))) {
        done.add(s.id);
        progressed = true;
      }
    }
  }
  const stuck = steps.filter((s) => !done.has(s.id));
  if (stuck.length) throw new HttpError(400, `steps form a dependency cycle: ${stuck.map((s) => s.name).join(' → ')}`);
}

/** A failed attempt either goes back to pending (to be retried) or fails the step for good. */
export function failAttempt(step: Step, st: StepState, message: string, now: Date): void {
  if (st.attempts <= step.retries) {
    st.status = 'pending';
    st.result = `attempt ${st.attempts} failed: ${message}`;
  } else {
    st.status = 'failed';
    st.finishedAt = now.toISOString();
    st.result = message;
  }
}

/** Run status implied by its steps (after failure propagation has been applied). */
export function runStatus(state: RunState): 'running' | 'waiting_approval' | 'succeeded' | 'failed' {
  const all = Object.values(state.steps);
  if (all.every((s) => s.status === 'succeeded')) return 'succeeded';
  const active = all.some((s) => s.status === 'running');
  if (all.some((s) => s.status === 'failed') && !active) return 'failed';
  if (!active && all.some((s) => s.status === 'waiting_approval')) return 'waiting_approval';
  return 'running';
}
