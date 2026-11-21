import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@viscosity/protocol';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../auth';
import { audit, HttpError, me, type Ctx } from '../context';
import { hashPassword, hashToken, newToken, newTotpSecret, verifyPassword, verifyTotp } from '../crypto';
import { schema } from '../db';

const Password = z.string().min(12, 'password must be at least 12 characters').max(256);
const Email = z.string().email().max(254).transform((e) => e.toLowerCase());
const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
// A real hash to burn equal time when the account does not exist.
const DUMMY_HASH = hashPassword('viscosity-dummy-password');

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;
  const U = schema.users;

  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string) {
    const token = newToken();
    await db.insert(schema.sessions).values({
      tokenHash: hashToken(token), userId, ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 300),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: SESSION_TTL_MS / 1000,
    });
  }

  app.get('/api/health', { config: { public: true } }, async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  app.get('/api/setup/status', { config: { public: true } }, async () => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(U);
    return { needsSetup: row!.n === 0, protocol: PROTOCOL_VERSION };
  });

  app.post('/api/setup', { config: { public: true, ...authLimit } }, async (req, reply) => {
    const body = z.object({ email: Email, password: Password }).parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7421)`); // serialise concurrent first-run attempts
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(U);
      if (row!.n > 0) throw new HttpError(409, 'setup has already been completed');
      const [created] = await tx.insert(U).values({ email: body.email, passwordHash, role: 'admin' }).returning();
      return created!;
    });
    await startSession(req, reply, user.id);
    await audit(ctx, req, 'setup.admin_created', user.email);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { public: true, ...authLimit } }, async (req, reply) => {
    const body = z.object({ email: Email, password: z.string().max(256), code: z.string().max(10).optional() }).parse(req.body);
    const [user] = await db.select().from(U).where(eq(U.email, body.email));
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await DUMMY_HASH));
    if (!user || !ok) {
      await audit(ctx, req, 'auth.login_failed', body.email);
      throw new HttpError(401, 'invalid email or password');
    }
    if (user.totpEnabled) {
      if (!body.code) throw new HttpError(401, 'verification code required', { mfaRequired: true });
      if (!verifyTotp(ctx.box.decrypt(user.totpSecretEnc!), body.code)) {
        await audit(ctx, req, 'auth.mfa_failed', user.email);
        throw new HttpError(401, 'invalid verification code', { mfaRequired: true });
      }
    }
    await startSession(req, reply, user.id);
    req.user = { id: user.id, email: user.email, role: user.role, sessionId: '' };
    await audit(ctx, req, 'auth.login', user.email);
    return { ok: true };
  });

  app.post('/api/auth/logout', { config: { role: 'viewer' } }, async (req, reply) => {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, me(req).sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = me(req);
    const [row] = await db.select({ totpEnabled: U.totpEnabled }).from(U).where(eq(U.id, user.id));
    return { id: user.id, email: user.email, role: user.role, mfaEnabled: row!.totpEnabled };
  });

  app.post('/api/auth/password', { config: { role: 'viewer', ...authLimit } }, async (req) => {
    const user = me(req);
    const body = z.object({ current: z.string(), next: Password }).parse(req.body);
    const [row] = await db.select().from(U).where(eq(U.id, user.id));
    if (!(await verifyPassword(body.current, row!.passwordHash))) throw new HttpError(403, 'current password is incorrect');
    await db.update(U).set({ passwordHash: await hashPassword(body.next) }).where(eq(U.id, user.id));
    // every other session is revoked
    await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.id, user.sessionId)));
    await audit(ctx, req, 'auth.password_changed', user.email);
    return { ok: true };
  });

  // ── MFA (TOTP) ──
  app.post('/api/auth/mfa/setup', { config: { role: 'viewer' } }, async (req) => {
    const user = me(req);
    const [row] = await db.select().from(U).where(eq(U.id, user.id));
    if (row!.totpEnabled) throw new HttpError(409, 'MFA is already enabled');
    const secret = newTotpSecret();
    await db.update(U).set({ totpSecretEnc: ctx.box.encrypt(secret) }).where(eq(U.id, user.id));
    const label = encodeURIComponent(`VISCOSITY CONTROL:${user.email}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=VISCOSITY%20CONTROL` };
  });

  app.post('/api/auth/mfa/enable', { config: { role: 'viewer', ...authLimit } }, async (req) => {
    const user = me(req);
    const { code } = z.object({ code: z.string().max(10) }).parse(req.body);
    const [row] = await db.select().from(U).where(eq(U.id, user.id));
    if (!row!.totpSecretEnc) throw new HttpError(409, 'start MFA setup first');
    if (!verifyTotp(ctx.box.decrypt(row!.totpSecretEnc), code)) throw new HttpError(400, 'that code is not valid');
    await db.update(U).set({ totpEnabled: true }).where(eq(U.id, user.id));
    await audit(ctx, req, 'auth.mfa_enabled', user.email);
    return { ok: true };
  });

  app.post('/api/auth/mfa/disable', { config: { role: 'viewer', ...authLimit } }, async (req) => {
    const user = me(req);
    const body = z.object({ password: z.string(), code: z.string().max(10) }).parse(req.body);
    const [row] = await db.select().from(U).where(eq(U.id, user.id));
    if (!row!.totpEnabled || !row!.totpSecretEnc) throw new HttpError(409, 'MFA is not enabled');
    if (!(await verifyPassword(body.password, row!.passwordHash)) || !verifyTotp(ctx.box.decrypt(row!.totpSecretEnc), body.code))
      throw new HttpError(403, 'password or code is incorrect');
    await db.update(U).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(U.id, user.id));
    await audit(ctx, req, 'auth.mfa_disabled', user.email);
    return { ok: true };
  });

  // ── preferences (layout, terminal font…) ──
  app.get('/api/preferences', async (req) => {
    const [row] = await db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, me(req).id));
    return row?.data ?? {};
  });
  app.put('/api/preferences', { config: { role: 'viewer' }, bodyLimit: 64 * 1024 }, async (req) => {
    const data = z.record(z.string(), z.unknown()).parse(req.body);
    await db.insert(schema.userPreferences).values({ userId: me(req).id, data })
      .onConflictDoUpdate({ target: schema.userPreferences.userId, set: { data, updatedAt: new Date() } });
    return { ok: true };
  });
}
