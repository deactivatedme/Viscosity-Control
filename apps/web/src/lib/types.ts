import type { AgentEventEnvelope, AgentProvider, BrowserEvent, BrowserStep, Metrics, PermissionMode, SystemInfo } from '@viscosity/protocol';

export interface Me { id: string; email: string; role: 'admin' | 'operator' | 'viewer'; mfaEnabled: boolean }

export interface Server {
  id: string; name: string; status: 'pending' | 'online' | 'offline'; enrolled: boolean;
  system: SystemInfo | null; remoteIp: string | null; lastSeenAt: string | null; createdAt: string; metrics: Metrics | null;
}
export interface ServerDetail extends Server {
  history: Metrics[];
  connections: { id: string; remoteIp: string | null; workerVersion: string | null; connectedAt: string; disconnectedAt: string | null }[];
}
export interface Enrollment { token: string; expiresAt: string; command: string }

export interface Approval { id: string; kind: 'agent' | 'browser' | 'workflow'; sessionId: string; serverId: string; approvalId: string; summary: string; payload: { tool?: string; input?: unknown } | null; status: string; createdAt: string }

export interface Agent {
  id: string; serverId: string; name: string; provider: AgentProvider; model: string | null; cwd: string;
  permissionMode: PermissionMode; worktreeBranch: string | null; worktreePath: string | null; command: string[] | null;
  credentialId: string | null; task: string; status: string; statusDetail: string | null; providerSessionId: string | null;
  lastSeq: number; inputTokens: number; outputTokens: number; costUsd: number | null;
  createdAt: string; startedAt: string | null; endedAt: string | null; archivedAt: string | null;
  serverOnline: boolean; capabilities: { resume: boolean; approvals: boolean; pause: boolean }; approvals?: Approval[];
}
export type AgentEnvelope = AgentEventEnvelope;

/** Stored browser events: screenshots carry only the URL; fetch the image by seq. */
export type StoredBrowserEvent = Exclude<BrowserEvent, { type: 'screenshot' }> | { type: 'screenshot'; url: string };
export interface BrowserEnvelope { sessionId: string; seq: number; ts: number; event: StoredBrowserEvent }
export interface BrowserSession {
  id: string; serverId: string; name: string; mode: 'steps' | 'agent'; task: string | null; startUrl: string | null;
  steps: BrowserStep[] | null; model: string | null; credentialId: string | null; status: string; statusDetail: string | null;
  currentUrl: string | null; lastSeq: number; lastScreenshotSeq: number | null;
  result: { ok: boolean; summary: string; data: unknown } | null;
  createdAt: string; startedAt: string | null; endedAt: string | null; serverOnline: boolean; approvals?: Approval[];
}

export interface Terminal { id: string; serverId: string; title: string; shell: string | null; runAs: string | null; status: 'open' | 'closed'; exitCode: number | null; createdAt: string }
export interface Credential { id: string; kind: 'anthropic' | 'openai' | 'github' | 'secret'; label: string; hint: string; createdAt: string; rotatedAt: string | null }
export interface Alert { id: string; level: 'info' | 'warning' | 'error'; title: string; body: string | null; link: string | null; serverId: string | null; readAt: string | null; createdAt: string }
export interface AuditEntry { id: number; ts: string; action: string; target: string | null; serverId: string | null; detail: unknown; ip: string | null; user: string | null }

export type WorkflowStepStatus = 'pending' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export interface WorkflowStep { id: string; name: string; kind: 'agent' | 'browser' | 'approval'; config: Record<string, unknown>; serverId: string; dependsOn: string[]; retries: number; timeoutSec?: number }
export interface WorkflowStepState { status: WorkflowStepStatus; attempts: number; sessionIds: string[]; startedAt?: string; finishedAt?: string; result?: string }
export interface WorkflowRun {
  id: string; workflowId: string; trigger: 'schedule' | 'manual';
  /** `started` only appears on runs recorded before the multi-step engine. */
  status: 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'started';
  sessionId: string | null; detail: string | null; startedAt: string; finishedAt: string | null;
  /** The definition the run started with, and each step's progress. */
  state: { def: WorkflowStep[]; name: string; steps: Record<string, WorkflowStepState> } | null;
}
export interface WorkflowItem {
  id: string; name: string; kind: 'agent' | 'browser'; serverId: string; steps: WorkflowStep[]; schedule: string | null; timezone: string;
  enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; createdAt: string; lastRun: WorkflowRun | null;
}
