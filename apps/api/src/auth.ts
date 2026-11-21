import type { FastifyInstance } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { HttpError, type Ctx } from './context';
import { hashToken } from './crypto';
import { schema } from './db';
import type { Role } from './db/schema';

export const SESSION_COOKIE = 'vc_session';
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
export const hasRole = (role: Role, need: Role) => RANK[role] >= RANK[need];

/**
 * Secure-by-default gate for every route: a session is required unless the route
 * opts out with `config.public`, mutating requests must come from an allowed
 * Origin (CSRF + WebSocket hijacking protection), and the role floor is enforced
 * server-side.
 */
export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const cfg = req.routeOptions.config;
    const isUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    const safe = (req.method === 'GET' || req.method === 'HEAD') && !isUpgrade;

    if (!cfg.worker && !safe) {
      const origin = req.headers.origin;
      if (!origin || !ctx.config.origins.includes(origin)) throw new HttpError(403, 'origin not allowed');
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const [row] = await ctx.db
        .select({ sessionId: schema.sessions.id, id: schema.users.id, email: schema.users.email, role: schema.users.role })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
        .where(and(eq(schema.sessions.tokenHash, hashToken(token)), gt(schema.sessions.expiresAt, new Date())));
      if (row) req.user = row;
    }

    if (cfg.public || cfg.worker) return;
    if (!req.user) throw new HttpError(401, 'not authenticated');
    const need = cfg.role ?? (safe ? 'viewer' : 'operator');
    if (!hasRole(req.user.role, need)) throw new HttpError(403, `requires ${need} role`);
  });
}
