import type { MethodName, MethodParsedParams, MethodResult, WorkerEventData, WorkerEventName } from '@viscosity/protocol';
import type { WorkerConfig } from './config';
import type { PathGuard } from './paths';

export interface Ctx {
  config: WorkerConfig;
  guard: PathGuard;
  /** Fire-and-forget event to the control plane; dropped while offline. */
  emit<E extends WorkerEventName>(topic: E, data: WorkerEventData<E>): void;
  /** Bytes waiting in the socket send buffer. */
  buffered(): number;
}

export type Handlers = { [M in MethodName]: (params: MethodParsedParams<M>) => Promise<MethodResult<M>> };

export const OK = { ok: true } as const;

/** Environment handed to agent/child processes: enough to run tools, none of the worker's own secrets. */
export function baseEnv(passthrough?: RegExp): Record<string, string> {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR|TERM|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/i;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (keep.test(key) || passthrough?.test(key))) env[key] = value;
  }
  return env;
}
