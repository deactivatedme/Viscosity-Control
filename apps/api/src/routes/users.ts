import type { FastifyInstance } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, HttpError, me, type Ctx } from '../context';
import { hashPassword } from '../crypto';
import { schema } from '../db';

const Id = z.object({ id: z.string().uuid() });
const Role = z.enum(['admin', 'operator', 'viewer']);
const Password = z.string().min(12, 'password must be at least 12 characters').max(256);

/** User administration. Every route is admin-only. */
export function userRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const U = schema.users;
  const admin = { config: { role: 'admin' as const } };
  const view = (u: typeof U.$inferSelect) => ({ id: u.id, email: u.email, role: u.role, mfaEnabled: u.totpEnabled, createdAt: u.createdAt });

  async function get(id: string) {
    const [u] = await db.select().from(U).where(eq(U.id, id));
    if (!u) throw new HttpError(404, 'user not found');
    return u;
  }
  /** The installation must always keep at least one administrator. */
  async function assertNotLastAdmin(id: string) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(U).where(and(eq(U.role, 'admin'), ne(U.id, id)));
    if (row!.n === 0) throw new HttpError(409, 'this is the only administrator; promote another user first');
  }

  app.get('/api/users', admin, async () => {
    const rows = await db.select().from(U).orderBy(U.createdAt);
    const sessions = await db.select({ userId: schema.sessions.userId, n: sql<number>`count(*)::int` }).from(schema.sessions)
      .where(sql`${schema.sessions.expiresAt} > now()`).groupBy(schema.sessions.userId);
    return rows.map((u) => ({ ...view(u), activeSessions: sessions.find((s) => s.userId === u.id)?.n ?? 0 }));
  });

  app.post('/api/users', admin, async (req) => {
    const body = z.object({ email: z.string().email().max(254).transform((e) => e.toLowerCase()), role: Role, password: Password }).parse(req.body);
    const [exists] = await db.select({ id: U.id }).from(U).where(eq(U.email, body.email));
    if (exists) throw new HttpError(409, 'a user with that email already exists');
    const [u] = await db.insert(U).values({ email: body.email, role: body.role, passwordHash: await hashPassword(body.password) }).returning();
    await audit(ctx, req, 'user.create', body.email, { detail: { role: body.role } });
    return view(u!);
  });

  app.patch('/api/users/:id', admin, async (req) => {
    const u = await get(Id.parse(req.params).id);
    const body = z.object({ role: Role.optional(), password: Password.optional() }).parse(req.body);
    if (body.role && body.role !== 'admin' && u.role === 'admin') await assertNotLastAdmin(u.id);
    const [updated] = await db.update(U).set({
      role: body.role ?? u.role,
      ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
    }).where(eq(U.id, u.id)).returning();
    // A new password or a changed role invalidates what that user's existing sessions were granted.
    if (body.password || (body.role && body.role !== u.role))
      await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, u.id), ne(schema.sessions.id, me(req).sessionId)));
    await audit(ctx, req, 'user.update', u.email, { detail: { role: body.role, passwordReset: !!body.password } });
    return view(updated!);
  });

  app.post('/api/users/:id/revoke-sessions', admin, async (req) => {
    const u = await get(Id.parse(req.params).id);
    await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, u.id), ne(schema.sessions.id, me(req).sessionId)));
    await audit(ctx, req, 'user.sessions_revoked', u.email);
    return { ok: true };
  });

  /** Lets an admin clear a locked-out user's second factor; the user re-enrols afterwards. */
  app.post('/api/users/:id/reset-mfa', admin, async (req) => {
    const u = await get(Id.parse(req.params).id);
    await db.update(U).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(U.id, u.id));
    await audit(ctx, req, 'user.mfa_reset', u.email);
    return { ok: true };
  });

  app.delete('/api/users/:id', admin, async (req) => {
    const u = await get(Id.parse(req.params).id);
    if (u.id === me(req).id) throw new HttpError(409, 'you cannot delete your own account');
    if (u.role === 'admin') await assertNotLastAdmin(u.id);
    await db.delete(U).where(eq(U.id, u.id)); // sessions cascade
    await audit(ctx, req, 'user.delete', u.email);
    return { ok: true };
  });
}
