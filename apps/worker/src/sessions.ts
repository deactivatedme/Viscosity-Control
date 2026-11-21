import { RpcError } from '@viscosity/protocol';
import { EventLog, type Envelope } from './eventlog';

export type Decision = { decision: 'allow' | 'deny'; reason?: string };
export type AbortReason = 'stopped' | 'timeout';

interface Active {
  abort: AbortController;
  timer: NodeJS.Timeout;
  approvals: Map<string, (decision: Decision) => void>;
}

export interface Run {
  signal: AbortSignal;
  /** Resolves when the operator decides; rejects if the run is stopped or times out first. */
  waitApproval(approvalId: string): Promise<Decision>;
}

/**
 * Lifecycle shared by agent and browser sessions: durable ordered events, one active
 * run per session id, operator stop, timeout, and pending approvals.
 */
export class Sessions<E> {
  private active = new Map<string, Active>();

  constructor(
    private log: EventLog<E>,
    private send: (envelope: Envelope<E>) => void,
  ) {}

  emit(sessionId: string, event: E): void {
    this.send(this.log.append(sessionId, event));
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  begin(sessionId: string, timeoutMs: number): Run {
    if (this.active.has(sessionId)) throw new RpcError('invalid', 'session is already running');
    const abort = new AbortController();
    const entry: Active = {
      abort,
      timer: setTimeout(() => abort.abort('timeout' satisfies AbortReason), timeoutMs),
      approvals: new Map(),
    };
    this.active.set(sessionId, entry);
    return {
      signal: abort.signal,
      waitApproval: (approvalId) =>
        new Promise<Decision>((resolve, reject) => {
          const onAbort = (): void => reject(new Error(`run ${abort.signal.reason as string} while waiting for approval`));
          abort.signal.addEventListener('abort', onAbort, { once: true });
          entry.approvals.set(approvalId, (decision) => {
            abort.signal.removeEventListener('abort', onAbort);
            resolve(decision);
          });
        }),
    };
  }

  end(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (entry) clearTimeout(entry.timer);
    this.active.delete(sessionId);
  }

  stop(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) throw new RpcError('not_found', 'session is not running on this worker');
    entry.abort.abort('stopped' satisfies AbortReason);
  }

  approve(sessionId: string, approvalId: string, decision: Decision): void {
    const resolve = this.active.get(sessionId)?.approvals.get(approvalId);
    if (!resolve) throw new RpcError('not_found', 'no pending approval with that id');
    this.active.get(sessionId)!.approvals.delete(approvalId);
    resolve(decision);
  }

  async replay(sessionId: string, afterSeq: number): Promise<{ count: number }> {
    return { count: await this.log.replay(sessionId, afterSeq, this.send) };
  }

  /** For the hello frame: recent sessions with their last seq and whether a run is live. */
  known(): { id: string; lastSeq: number; active: boolean }[] {
    return this.log.known(7 * 24 * 3600_000).map((s) => ({ ...s, active: this.active.has(s.id) }));
  }

  stopAll(): void {
    for (const entry of this.active.values()) entry.abort.abort('stopped' satisfies AbortReason);
  }
}
