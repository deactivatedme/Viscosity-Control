/**
 * VISCOSITY CONTROL — control-plane ⇄ worker protocol.
 * Both sides validate with these schemas: the worker validates params (clean errors,
 * defence in depth), the control plane validates everything a worker sends (a worker
 * is a less-trusted peer).
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ───────────────────────── shared domain types ─────────────────────────

export const SystemInfo = z.object({
  hostname: z.string(),
  platform: z.string(),
  distro: z.string(),
  kernel: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number().int(),
  memTotal: z.number(),
  ips: z.array(z.string()),
  user: z.string(),
  workerVersion: z.string(),
  /** Directories the worker allows file/agent/terminal access to. */
  roots: z.array(z.string()),
  capabilities: z.object({
    pty: z.boolean(),
    docker: z.boolean(),
    git: z.boolean(),
    browser: z.boolean(),
    claude: z.boolean(),
    codex: z.boolean(),
    reboot: z.boolean(),
  }),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

export const Metrics = z.object({
  ts: z.number(),
  cpu: z.number(), // percent 0–100 across all cores
  load: z.tuple([z.number(), z.number(), z.number()]),
  memTotal: z.number(),
  memAvailable: z.number(),
  diskTotal: z.number(),
  diskUsed: z.number(),
  netRxBps: z.number(),
  netTxBps: z.number(),
  uptime: z.number(), // seconds
  processes: z.number().int(),
  containers: z.number().int().nullable(), // null = docker unavailable
  agents: z.number().int(),
});
export type Metrics = z.infer<typeof Metrics>;

export const ProcessInfo = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  cpu: z.number(),
  rss: z.number(),
  elapsed: z.string(),
  command: z.string(),
});
export type ProcessInfo = z.infer<typeof ProcessInfo>;

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number(),
  mtime: z.number(),
  mode: z.string(), // e.g. "rwxr-xr-x"
  owner: z.string(),
});
export type FsEntry = z.infer<typeof FsEntry>;

export const Container = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  ports: z.string(),
  createdAt: z.string(),
  composeProject: z.string().nullable(),
  health: z.string().nullable(),
});
export type Container = z.infer<typeof Container>;

export const ContainerStats = z.object({
  id: z.string(),
  cpuPct: z.number(),
  memUsed: z.number(),
  memLimit: z.number(),
});
export type ContainerStats = z.infer<typeof ContainerStats>;

export const GitStatus = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), status: z.string() })),
});
export type GitStatus = z.infer<typeof GitStatus>;

// ───────────────────────── agents ─────────────────────────

export const AgentProvider = z.enum(['claude', 'codex', 'custom']);
export type AgentProvider = z.infer<typeof AgentProvider>;

/**
 * ask         – every edit/command needs dashboard approval (Claude only)
 * acceptEdits – file edits auto-approved, commands need approval (Claude) / workspace-write sandbox (Codex)
 * auto        – no approvals
 * readonly    – plan/read-only, no modifications
 */
export const PermissionMode = z.enum(['ask', 'acceptEdits', 'auto', 'readonly']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const AgentStatus = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'stopped',
  'lost', // worker restarted or forgot the session while it was running
]);
export type AgentStatus = z.infer<typeof AgentStatus>;
export const ACTIVE_AGENT_STATUSES: AgentStatus[] = ['queued', 'starting', 'running', 'waiting_approval'];

export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: AgentStatus, detail: z.string().optional() }),
  z.object({ type: z.literal('user'), text: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal('file_change'), path: z.string(), kind: z.string() }),
  z.object({ type: z.literal('output'), stream: z.enum(['stdout', 'stderr']), text: z.string() }),
  z.object({
    type: z.literal('approval_request'),
    approvalId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('approval_resolved'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'deny']),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number().nullable(),
  }),
  z.object({
    type: z.literal('result'),
    ok: z.boolean(),
    summary: z.string(),
    durationMs: z.number(),
    providerSessionId: z.string().nullable(),
    worktree: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const AgentEventEnvelope = z.object({
  sessionId: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  event: AgentEvent,
});
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelope>;

export const AgentStartParams = z.object({
  sessionId: z.string().uuid(),
  provider: AgentProvider,
  cwd: z.string(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  permissionMode: PermissionMode,
  /** Create/use an isolated git worktree on this branch before running. */
  worktreeBranch: z.string().regex(/^[\w./-]+$/).optional(),
  /** Provider-native session/thread id to resume. */
  resume: z.string().optional(),
  /** Provider credentials; held in worker memory only for the lifetime of the run. */
  env: z.record(z.string(), z.string()).default({}),
  /** argv for provider=custom (no shell). The prompt is appended as the final argument. */
  command: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(24 * 3600_000).default(2 * 3600_000),
});
export type AgentStartParams = z.infer<typeof AgentStartParams>;

// ───────────────────────── browser ─────────────────────────

export const BrowserStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().url() }),
  z.object({ action: z.literal('click'), selector: z.string() }),
  z.object({ action: z.literal('fill'), selector: z.string(), value: z.string() }),
  z.object({ action: z.literal('press'), key: z.string() }),
  z.object({ action: z.literal('waitFor'), selector: z.string() }),
  z.object({ action: z.literal('extract'), selector: z.string(), attribute: z.string().optional() }),
  z.object({ action: z.literal('screenshot') }),
  z.object({ action: z.literal('approval'), reason: z.string() }),
]);
export type BrowserStep = z.infer<typeof BrowserStep>;

export const BrowserStatus = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'stopped',
  'lost',
]);
export type BrowserStatus = z.infer<typeof BrowserStatus>;

export const BrowserEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: BrowserStatus, detail: z.string().optional() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('action'),
    action: z.string(),
    detail: z.string(),
    ok: z.boolean(),
    /** What was checked after the action to confirm it took effect. */
    verified: z.string().optional(),
    error: z.string().optional(),
    url: z.string(),
    title: z.string(),
  }),
  /** JPEG, base64. Stored on disk by the control plane, never in Postgres. */
  z.object({ type: z.literal('screenshot'), data: z.string(), url: z.string() }),
  z.object({ type: z.literal('blocked'), url: z.string(), reason: z.string() }),
  z.object({ type: z.literal('approval_request'), approvalId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal('approval_resolved'),
    approvalId: z.string(),
    decision: z.enum(['allow', 'deny']),
  }),
  z.object({ type: z.literal('result'), ok: z.boolean(), summary: z.string(), data: z.unknown().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type BrowserEvent = z.infer<typeof BrowserEvent>;

export const BrowserEventEnvelope = z.object({
  sessionId: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  event: BrowserEvent,
});
export type BrowserEventEnvelope = z.infer<typeof BrowserEventEnvelope>;

export const BrowserStartParams = z.object({
  sessionId: z.string().uuid(),
  mode: z.enum(['steps', 'agent']),
  startUrl: z.string().url().optional(),
  steps: z.array(BrowserStep).max(200).optional(),
  task: z.string().optional(),
  llm: z.object({ apiKey: z.string(), model: z.string() }).optional(),
  maxSteps: z.number().int().positive().max(200).default(40),
  timeoutMs: z.number().int().positive().max(3600_000).default(10 * 60_000),
});
export type BrowserStartParams = z.infer<typeof BrowserStartParams>;

// ───────────────────────── RPC methods (control → worker) ─────────────────────────

const empty = z.object({});
const ok = z.object({ ok: z.literal(true) });
const cwd = z.object({ cwd: z.string() });

export const methods = {
  'system.info': { params: empty, result: SystemInfo },
  'system.reboot': { params: empty, result: ok },
  'system.logs': {
    params: z.object({ unit: z.string().regex(/^[\w@.:-]+$/).optional(), lines: z.number().int().max(2000).default(200) }),
    result: z.object({ text: z.string() }),
  },

  'process.list': { params: empty, result: z.array(ProcessInfo) },
  'process.kill': {
    params: z.object({ pid: z.number().int().positive(), signal: z.enum(['TERM', 'KILL', 'INT', 'HUP']).default('TERM') }),
    result: ok,
  },

  'fs.list': { params: z.object({ path: z.string() }), result: z.array(FsEntry) },
  'fs.stat': { params: z.object({ path: z.string() }), result: FsEntry },
  /** Chunked read; `data` is base64. */
  'fs.read': {
    params: z.object({ path: z.string(), offset: z.number().int().min(0).default(0), length: z.number().int().positive().max(1_048_576).default(1_048_576) }),
    result: z.object({ data: z.string(), size: z.number(), eof: z.boolean() }),
  },
  /** Chunked write; offset 0 truncates, later chunks append at offset. */
  'fs.write': {
    params: z.object({ path: z.string(), data: z.string(), offset: z.number().int().min(0).default(0) }),
    result: ok,
  },
  'fs.mkdir': { params: z.object({ path: z.string() }), result: ok },
  'fs.rename': { params: z.object({ from: z.string(), to: z.string() }), result: ok },
  'fs.delete': { params: z.object({ path: z.string(), recursive: z.boolean().default(false) }), result: ok },
  'fs.search': {
    params: z.object({ path: z.string(), query: z.string().min(1).max(200), limit: z.number().int().max(500).default(200) }),
    result: z.array(FsEntry),
  },

  'docker.list': { params: empty, result: z.array(Container) },
  'docker.inspect': { params: z.object({ id: z.string().regex(/^[\w.-]+$/) }), result: z.unknown() },
  'docker.logs': {
    params: z.object({ id: z.string().regex(/^[\w.-]+$/), tail: z.number().int().max(5000).default(300) }),
    result: z.object({ text: z.string() }),
  },
  'docker.action': {
    params: z.object({ id: z.string().regex(/^[\w.-]+$/), action: z.enum(['start', 'stop', 'restart']) }),
    result: ok,
  },
  'docker.stats': { params: empty, result: z.array(ContainerStats) },

  'pty.open': {
    params: z.object({ id: z.string().uuid(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300), cwd: z.string().optional() }),
    result: z.object({ pid: z.number().int(), shell: z.string(), user: z.string() }),
  },
  /** Re-attach after a dashboard/control-plane reconnect; returns buffered scrollback (base64). */
  'pty.attach': {
    params: z.object({ id: z.string().uuid() }),
    result: z.object({ alive: z.boolean(), scrollback: z.string(), exitCode: z.number().nullable() }),
  },
  'pty.close': { params: z.object({ id: z.string().uuid() }), result: ok },
  'pty.list': { params: empty, result: z.array(z.object({ id: z.string(), alive: z.boolean() })) },

  'git.status': { params: cwd, result: GitStatus },
  'git.diff': { params: z.object({ cwd: z.string(), path: z.string().optional() }), result: z.object({ diff: z.string(), truncated: z.boolean() }) },

  'agent.start': { params: AgentStartParams, result: ok },
  'agent.stop': { params: z.object({ sessionId: z.string().uuid() }), result: ok },
  'agent.approve': {
    params: z.object({ sessionId: z.string().uuid(), approvalId: z.string(), decision: z.enum(['allow', 'deny']), reason: z.string().optional() }),
    result: ok,
  },
  /** Re-emit persisted events with seq > afterSeq (reconciliation after a disconnect). */
  'agent.replay': { params: z.object({ sessionId: z.string().uuid(), afterSeq: z.number().int() }), result: z.object({ count: z.number().int() }) },

  'browser.start': { params: BrowserStartParams, result: ok },
  'browser.stop': { params: z.object({ sessionId: z.string().uuid() }), result: ok },
  'browser.approve': {
    params: z.object({ sessionId: z.string().uuid(), approvalId: z.string(), decision: z.enum(['allow', 'deny']) }),
    result: ok,
  },
  'browser.replay': { params: z.object({ sessionId: z.string().uuid(), afterSeq: z.number().int() }), result: z.object({ count: z.number().int() }) },
} as const;

export type MethodName = keyof typeof methods;
export type MethodParams<M extends MethodName> = z.input<(typeof methods)[M]['params']>;
export type MethodParsedParams<M extends MethodName> = z.output<(typeof methods)[M]['params']>;
export type MethodResult<M extends MethodName> = z.output<(typeof methods)[M]['result']>;

// ───────────────────────── events ─────────────────────────

/** worker → control */
export const workerEvents = {
  metrics: Metrics,
  'pty.data': z.object({ id: z.string(), data: z.string() }),
  'pty.exit': z.object({ id: z.string(), exitCode: z.number().nullable() }),
  'agent.event': AgentEventEnvelope,
  'browser.event': BrowserEventEnvelope,
} as const;
export type WorkerEventName = keyof typeof workerEvents;
export type WorkerEventData<E extends WorkerEventName> = z.output<(typeof workerEvents)[E]>;

/** control → worker (fire and forget) */
export const controlEvents = {
  'pty.input': z.object({ id: z.string(), data: z.string() }),
  'pty.resize': z.object({ id: z.string(), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }),
} as const;
export type ControlEventName = keyof typeof controlEvents;
export type ControlEventData<E extends ControlEventName> = z.output<(typeof controlEvents)[E]>;

// ───────────────────────── wire envelopes ─────────────────────────

export const RpcErrorCode = z.enum(['invalid', 'forbidden', 'not_found', 'unsupported', 'failed', 'timeout', 'offline']);
export type RpcErrorCode = z.infer<typeof RpcErrorCode>;

/** Sessions the worker still knows about, sent on connect so the control plane can reconcile. */
export const KnownSession = z.object({ id: z.string(), lastSeq: z.number().int(), active: z.boolean() });

export const Frame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.number().int(),
    system: SystemInfo,
    agents: z.array(KnownSession),
    browsers: z.array(KnownSession),
  }),
  z.object({ t: z.literal('req'), id: z.string(), method: z.string(), params: z.unknown() }),
  z.object({
    t: z.literal('res'),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: RpcErrorCode, message: z.string() }).optional(),
  }),
  z.object({ t: z.literal('evt'), topic: z.string(), data: z.unknown() }),
]);
export type Frame = z.infer<typeof Frame>;

export class RpcError extends Error {
  constructor(
    public code: RpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** POST /api/worker/enroll */
export const EnrollRequest = z.object({ token: z.string().min(20), protocol: z.number().int(), hostname: z.string().max(255) });
export const EnrollResponse = z.object({ serverId: z.string().uuid(), secret: z.string() });
export type EnrollResponse = z.infer<typeof EnrollResponse>;
