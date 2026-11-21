import { sql } from 'drizzle-orm';
import {
  bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import type { SystemInfo } from '@viscosity/protocol';

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const roleEnum = pgEnum('role', ['admin', 'operator', 'viewer']);
export type Role = (typeof roleEnum.enumValues)[number];

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull().default('viewer'),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const servers = pgTable('servers', {
  id: id(),
  name: text('name').notNull(),
  /** pending = never enrolled; online/offline reflect the live worker connection only. */
  status: text('status', { enum: ['pending', 'online', 'offline'] }).notNull().default('pending'),
  credentialHash: text('credential_hash'),
  system: jsonb('system').$type<SystemInfo>(),
  remoteIp: text('remote_ip'),
  lastSeenAt: ts('last_seen_at'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

/** Single-use, short-lived worker enrollment credentials. Only the hash is stored. */
export const enrollmentTokens = pgTable('enrollment_tokens', {
  id: id(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

export const serverConnections = pgTable('server_connections', {
  id: id(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  remoteIp: text('remote_ip'),
  workerVersion: text('worker_version'),
  connectedAt: ts('connected_at').notNull().defaultNow(),
  disconnectedAt: ts('disconnected_at'),
}, (t) => [index('server_connections_server_idx').on(t.serverId, t.connectedAt)]);

/** Provider/API secrets. `secretEnc` is AES-256-GCM; plaintext never leaves the API except to a worker at run start. */
export const credentials = pgTable('credentials', {
  id: id(),
  kind: text('kind', { enum: ['anthropic', 'openai', 'github'] }).notNull(),
  label: text('label').notNull(),
  secretEnc: text('secret_enc').notNull(),
  hint: text('hint').notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  rotatedAt: ts('rotated_at'),
});

export const agentSessions = pgTable('agent_sessions', {
  id: id(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  provider: text('provider', { enum: ['claude', 'codex', 'custom'] }).notNull(),
  model: text('model'),
  cwd: text('cwd').notNull(),
  permissionMode: text('permission_mode', { enum: ['ask', 'acceptEdits', 'auto', 'readonly'] }).notNull(),
  worktreeBranch: text('worktree_branch'),
  worktreePath: text('worktree_path'),
  command: jsonb('command').$type<string[]>(),
  credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
  /** The prompt of the current/last run (also what a queued session will start with). */
  task: text('task').notNull(),
  status: text('status').notNull().default('queued'),
  statusDetail: text('status_detail'),
  providerSessionId: text('provider_session_id'),
  lastSeq: integer('last_seq').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
  archivedAt: ts('archived_at'),
}, (t) => [index('agent_sessions_server_idx').on(t.serverId), index('agent_sessions_status_idx').on(t.status)]);

/** Structured agent events (text, tool calls, status). Bulk byte streams (terminals, screenshots) never land here. */
export const agentEvents = pgTable('agent_events', {
  sessionId: uuid('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  ts: ts('ts').notNull(),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]);

export const browserSessions = pgTable('browser_sessions', {
  id: id(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mode: text('mode', { enum: ['steps', 'agent'] }).notNull(),
  task: text('task'),
  startUrl: text('start_url'),
  steps: jsonb('steps'),
  model: text('model'),
  credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('queued'),
  statusDetail: text('status_detail'),
  currentUrl: text('current_url'),
  lastSeq: integer('last_seq').notNull().default(0),
  lastScreenshotSeq: integer('last_screenshot_seq'),
  result: jsonb('result'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  startedAt: ts('started_at'),
  endedAt: ts('ended_at'),
}, (t) => [index('browser_sessions_server_idx').on(t.serverId)]);

export const browserEvents = pgTable('browser_events', {
  sessionId: uuid('session_id').notNull().references(() => browserSessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  ts: ts('ts').notNull(),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
}, (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]);

/** Approval gates raised by agents and browser sessions. The worker is the source of truth for resolution. */
export const approvals = pgTable('approvals', {
  id: id(),
  kind: text('kind', { enum: ['agent', 'browser'] }).notNull(),
  sessionId: uuid('session_id').notNull(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  approvalId: text('approval_id').notNull(),
  summary: text('summary').notNull(),
  payload: jsonb('payload'),
  status: text('status', { enum: ['pending', 'allowed', 'denied', 'expired'] }).notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  decidedAt: ts('decided_at'),
}, (t) => [uniqueIndex('approvals_session_approval_idx').on(t.sessionId, t.approvalId), index('approvals_status_idx').on(t.status)]);

/** Terminal metadata only — PTY bytes live in the worker's scrollback ring, not in Postgres. */
export const terminalSessions = pgTable('terminal_sessions', {
  id: id(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  shell: text('shell'),
  runAs: text('run_as'),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  exitCode: integer('exit_code'),
  closeReason: text('close_reason'),
  createdAt: createdAt(),
  closedAt: ts('closed_at'),
}, (t) => [index('terminal_sessions_server_idx').on(t.serverId)]);

export const alerts = pgTable('alerts', {
  id: id(),
  level: text('level', { enum: ['info', 'warning', 'error'] }).notNull(),
  title: text('title').notNull(),
  body: text('body'),
  /** e.g. "agent:<id>" — lets the dashboard deep-link. */
  link: text('link'),
  serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('alerts_created_idx').on(t.createdAt)]);

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: ts('ts').notNull().defaultNow(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  target: text('target'),
  serverId: uuid('server_id'),
  detail: jsonb('detail'),
  ip: text('ip'),
}, (t) => [index('audit_logs_ts_idx').on(t.ts)]);

/**
 * A reusable, optionally scheduled run. `config` is the creation payload of an agent or
 * browser session (captured from one that already ran), replayed on each firing.
 */
export const workflows = pgTable('workflows', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['agent', 'browser'] }).notNull(),
  serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  /** 5-field cron expression; null = manual runs only. */
  schedule: text('schedule'),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: boolean('enabled').notNull().default(true),
  nextRunAt: ts('next_run_at'),
  lastRunAt: ts('last_run_at'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('workflows_due_idx').on(t.enabled, t.nextRunAt)]);

export const workflowRuns = pgTable('workflow_runs', {
  id: id(),
  workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  trigger: text('trigger', { enum: ['schedule', 'manual'] }).notNull(),
  /** started = a session was created (its own status is the outcome); skipped/failed never produced one. */
  status: text('status', { enum: ['started', 'skipped', 'failed'] }).notNull(),
  sessionId: uuid('session_id'),
  detail: text('detail'),
  startedAt: ts('started_at').notNull().defaultNow(),
}, (t) => [index('workflow_runs_workflow_idx').on(t.workflowId, t.startedAt)]);
