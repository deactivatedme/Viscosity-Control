import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { RpcError } from '@viscosity/protocol';
import { audit, HttpError, me, type Ctx } from '../context';
import { hasRole } from '../auth';
import { schema } from '../db';

const Resize = z.object({ t: z.literal('resize'), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) });

/**
 * Browser ⇄ API ⇄ worker PTY relay.
 * Browser frames: binary = keystrokes; text = JSON control ({t:'resize',cols,rows}).
 * Server frames:  binary = PTY output; text = JSON ({t:'reset'|'status'|'exit'|'error'}).
 * The PTY lives on the worker, so closing the browser tab or losing the control
 * plane does not kill the shell; re-attaching replays the worker's scrollback.
 */
export function terminalRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub, dash } = ctx;
  const T = schema.terminalSessions;
  /** ptyId → attached browser sockets (plus the owning server, to reject cross-server injection). */
  const live = new Map<string, { serverId: string; sockets: Set<WebSocket> }>();
  const control = (s: WebSocket, msg: object) => s.readyState === s.OPEN && s.send(JSON.stringify(msg));

  hub.on('pty.data', (serverId, { id, data }) => {
    const t = live.get(id);
    if (!t || t.serverId !== serverId) return;
    const buf = Buffer.from(data, 'base64');
    for (const s of t.sockets) {
      // A browser that cannot keep up is dropped; on reconnect it replays scrollback from the worker.
      if (s.bufferedAmount > 8 * 1024 * 1024) s.close(1013, 'terminal output backlog; reconnect');
      else if (s.readyState === s.OPEN) s.send(buf, { binary: true });
    }
  });

  hub.on('pty.exit', async (serverId, { id, exitCode }) => {
    const [row] = await db.update(T).set({ status: 'closed', exitCode, closedAt: new Date(), closeReason: 'process exited' })
      .where(and(eq(T.id, id), eq(T.serverId, serverId), eq(T.status, 'open'))).returning();
    if (!row) return;
    for (const s of live.get(id)?.sockets ?? []) control(s, { t: 'exit', exitCode });
    dash.publish('terminals', { id });
  });

  hub.on('offline', (serverId) => {
    for (const t of live.values()) if (t.serverId === serverId) for (const s of t.sockets) control(s, { t: 'status', online: false });
  });

  /** (Re)attach a browser socket: replay scrollback, or close the session if the worker lost the PTY. */
  async function attach(id: string, serverId: string, socket: WebSocket) {
    try {
      const r = await hub.call(serverId, 'pty.attach', { id });
      control(socket, { t: 'reset' });
      if (r.scrollback) socket.send(Buffer.from(r.scrollback, 'base64'), { binary: true });
      if (r.alive) return control(socket, { t: 'status', online: true });
      await db.update(T).set({ status: 'closed', exitCode: r.exitCode, closedAt: new Date(), closeReason: 'process exited' })
        .where(and(eq(T.id, id), eq(T.status, 'open')));
      control(socket, { t: 'exit', exitCode: r.exitCode });
    } catch (err) {
      if (err instanceof RpcError && err.code === 'offline') return control(socket, { t: 'status', online: false });
      if (err instanceof RpcError && err.code === 'not_found') {
        await db.update(T).set({ status: 'closed', closedAt: new Date(), closeReason: 'worker restarted' }).where(and(eq(T.id, id), eq(T.status, 'open')));
        dash.publish('terminals', { id });
        return control(socket, { t: 'exit', exitCode: null, reason: 'The worker restarted and this shell no longer exists.' });
      }
      control(socket, { t: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
  hub.on('hello', async (serverId) => {
    for (const [id, t] of live) if (t.serverId === serverId) for (const s of t.sockets) await attach(id, serverId, s);
  });

  app.get('/api/terminals', async (req) => {
    const user = me(req);
    const rows = await db.select().from(T).where(eq(T.status, 'open')).orderBy(desc(T.createdAt));
    return rows.filter((r) => r.userId === user.id || user.role === 'admin');
  });

  app.post('/api/servers/:id/terminals', async (req) => {
    const { id: serverId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ cols: z.number().int().min(2).max(500).default(100), rows: z.number().int().min(2).max(300).default(30), cwd: z.string().optional() }).parse(req.body ?? {});
    const [server] = await db.select().from(schema.servers).where(eq(schema.servers.id, serverId));
    if (!server) throw new HttpError(404, 'server not found');
    const [row] = await db.insert(T).values({ serverId, userId: me(req).id, title: server.name }).returning();
    try {
      const pty = await hub.call(serverId, 'pty.open', { id: row!.id, ...body });
      const [updated] = await db.update(T).set({ shell: pty.shell, runAs: pty.user, title: `${pty.user}@${server.name}` }).where(eq(T.id, row!.id)).returning();
      await audit(ctx, req, 'terminal.open', updated!.title, { serverId, detail: { runAs: pty.user } });
      dash.publish('terminals', { id: row!.id });
      return updated;
    } catch (err) {
      await db.delete(T).where(eq(T.id, row!.id));
      throw err;
    }
  });

  app.delete('/api/terminals/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const user = me(req);
    const [row] = await db.select().from(T).where(eq(T.id, id));
    if (!row || (row.userId !== user.id && user.role !== 'admin')) throw new HttpError(404, 'terminal not found');
    if (row.status === 'open') {
      try {
        await hub.call(row.serverId, 'pty.close', { id });
      } catch (err) {
        // Offline/unknown PTY: there is nothing left to kill from here, record why.
        if (!(err instanceof RpcError && (err.code === 'offline' || err.code === 'not_found'))) throw err;
      }
      await db.update(T).set({ status: 'closed', closedAt: new Date(), closeReason: 'closed by user' }).where(and(eq(T.id, id), eq(T.status, 'open')));
    }
    await audit(ctx, req, 'terminal.close', row.title, { serverId: row.serverId });
    dash.publish('terminals', { id });
    return { ok: true };
  });

  app.get('/ws/terminal/:id', {
    websocket: true,
    preValidation: async (req) => {
      const user = me(req);
      if (!hasRole(user.role, 'operator')) throw new HttpError(403, 'requires operator role');
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const [row] = await db.select().from(T).where(eq(T.id, id));
      if (!row || (row.userId !== user.id && user.role !== 'admin')) throw new HttpError(404, 'terminal not found');
      (req as typeof req & { term: typeof row }).term = row;
    },
  }, (socket, req) => {
    const row = (req as typeof req & { term: typeof T.$inferSelect }).term;
    const entry = live.get(row.id) ?? { serverId: row.serverId, sockets: new Set<WebSocket>() };
    live.set(row.id, entry);
    entry.sockets.add(socket);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!hub.send(row.serverId, 'pty.input', { id: row.id, data: (raw as Buffer).toString('base64') }))
          control(socket, { t: 'status', online: false });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return socket.close(1003, 'malformed control frame');
      }
      const msg = Resize.safeParse(json);
      if (msg.success) hub.send(row.serverId, 'pty.resize', { id: row.id, cols: msg.data.cols, rows: msg.data.rows });
    });
    socket.on('close', () => {
      entry.sockets.delete(socket);
      if (entry.sockets.size === 0) live.delete(row.id);
    });
    socket.on('error', (err) => ctx.log.warn({ err }, 'terminal socket error'));

    if (row.status === 'closed') control(socket, { t: 'exit', exitCode: row.exitCode, reason: row.closeReason });
    else void attach(row.id, row.serverId, socket);
  });
}
