import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { RpcError, type RpcErrorCode } from '@viscosity/protocol';
import type { Config } from './config';
import type { SecretBox } from './crypto';
import { schema, type Db } from './db';
import type { DashboardHub } from './hub/dashboard';
import type { WorkerHub } from './hub/workers';
import type { Role } from './db/schema';

export interface Ctx {
  config: Config;
  db: Db;
  hub: WorkerHub;
  dash: DashboardHub;
  box: SecretBox;
  log: FastifyBaseLogger;
  /** Set while shutting down: sockets are closing and the database is about to go away. */
  closing: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
  interface FastifyContextConfig {
    /** No session required. */
    public?: boolean;
    /** Minimum role. Default: viewer for GET/HEAD, operator for everything else. */
    role?: Role;
    /** Called by workers, not browsers: skips the Origin check. */
    worker?: boolean;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const RPC_STATUS: Record<RpcErrorCode, number> = {
  invalid: 400, forbidden: 403, not_found: 404, unsupported: 501, failed: 502, timeout: 504, offline: 503,
};
export const rpcStatus = (e: RpcError) => RPC_STATUS[e.code];

export function me(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, 'not authenticated');
  return req.user;
}

export async function audit(ctx: Ctx, req: FastifyRequest | null, action: string, target?: string, extra?: { serverId?: string; detail?: unknown; userId?: string | null }) {
  await ctx.db.insert(schema.auditLogs).values({
    userId: req?.user?.id ?? extra?.userId ?? null,
    action,
    target: target ?? null,
    serverId: extra?.serverId ?? null,
    detail: extra?.detail ?? null,
    ip: req?.ip ?? null,
  });
}

export async function alert(ctx: Ctx, a: { level: 'info' | 'warning' | 'error'; title: string; body?: string; link?: string; serverId?: string }) {
  const [row] = await ctx.db.insert(schema.alerts).values(a).returning();
  ctx.dash.publish('alerts', row);
}
