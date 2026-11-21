import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import path from 'node:path';
import { z } from 'zod';
import { audit, HttpError, type Ctx } from '../context';
import { schema } from '../db';

const Sid = z.object({ id: z.string().uuid() });
const P = z.object({ path: z.string().min(1).max(4096) });
const EDIT_LIMIT = 2 * 1024 * 1024;
const CHUNK = 512 * 1024;

/** Thin, audited, role-gated proxies onto worker RPCs. All path/permission enforcement happens on the worker. */
export function opsRoutes(app: FastifyInstance, ctx: Ctx) {
  const { hub, db } = ctx;
  const sid = (req: FastifyRequest) => Sid.parse(req.params).id;

  // ── processes ──
  app.get('/api/servers/:id/processes', (req) => hub.call(sid(req), 'process.list', {}));
  app.post('/api/servers/:id/processes/:pid/kill', async (req) => {
    const id = sid(req);
    const { pid } = z.object({ pid: z.coerce.number().int().positive() }).parse(req.params);
    const { signal } = z.object({ signal: z.enum(['TERM', 'KILL', 'INT', 'HUP']).default('TERM') }).parse(req.body ?? {});
    await hub.call(id, 'process.kill', { pid, signal });
    await audit(ctx, req, 'process.kill', String(pid), { serverId: id, detail: { signal } });
    return { ok: true };
  });

  app.get('/api/servers/:id/logs', (req) => {
    const q = z.object({ unit: z.string().optional(), lines: z.coerce.number().int().max(2000).default(200) }).parse(req.query);
    return hub.call(sid(req), 'system.logs', q);
  });

  app.post('/api/servers/:id/reboot', { config: { role: 'admin' } }, async (req) => {
    const id = sid(req);
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
    const [s] = await db.select().from(schema.servers).where(eq(schema.servers.id, id));
    if (!s) throw new HttpError(404, 'server not found');
    if (confirm !== s.name) throw new HttpError(400, 'type the server name to confirm the reboot');
    await audit(ctx, req, 'server.reboot', s.name, { serverId: id });
    await hub.call(id, 'system.reboot', {});
    return { ok: true };
  });

  // ── files ──
  app.get('/api/servers/:id/fs/list', (req) => hub.call(sid(req), 'fs.list', P.parse(req.query)));
  app.get('/api/servers/:id/fs/stat', (req) => hub.call(sid(req), 'fs.stat', P.parse(req.query)));
  app.get('/api/servers/:id/fs/search', (req) =>
    hub.call(sid(req), 'fs.search', z.object({ path: z.string(), query: z.string().min(1).max(200) }).parse(req.query), 60_000));

  app.get('/api/servers/:id/fs/read', async (req) => {
    const id = sid(req);
    const { path: p } = P.parse(req.query);
    const stat = await hub.call(id, 'fs.stat', { path: p });
    if (stat.type !== 'file') throw new HttpError(400, 'not a regular file');
    if (stat.size > EDIT_LIMIT) throw new HttpError(413, 'file is too large to open in the editor; download it instead');
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const r = await hub.call(id, 'fs.read', { path: p, offset });
      const buf = Buffer.from(r.data, 'base64');
      parts.push(buf);
      offset += buf.length;
      if (r.eof || buf.length === 0) break;
    }
    const buf = Buffer.concat(parts);
    if (buf.includes(0)) return { binary: true, size: stat.size, mtime: stat.mtime };
    return { binary: false, content: buf.toString('utf8'), size: stat.size, mtime: stat.mtime };
  });

  app.put('/api/servers/:id/fs/write', { bodyLimit: EDIT_LIMIT * 2 }, async (req) => {
    const id = sid(req);
    const body = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body);
    const buf = Buffer.from(body.content, 'utf8');
    let offset = 0;
    do {
      const chunk = buf.subarray(offset, offset + CHUNK);
      await hub.call(id, 'fs.write', { path: body.path, data: chunk.toString('base64'), offset });
      offset += chunk.length;
    } while (offset < buf.length);
    await audit(ctx, req, 'fs.write', body.path, { serverId: id, detail: { bytes: buf.length } });
    return { ok: true };
  });

  app.get('/api/servers/:id/fs/download', async (req, reply) => {
    const id = sid(req);
    const { path: p } = P.parse(req.query);
    const stat = await hub.call(id, 'fs.stat', { path: p });
    if (stat.type !== 'file') throw new HttpError(400, 'not a regular file');
    async function* chunks() {
      for (let offset = 0; ; ) {
        const r = await hub.call(id, 'fs.read', { path: p, offset });
        const buf = Buffer.from(r.data, 'base64');
        if (buf.length) yield buf;
        offset += buf.length;
        if (r.eof || buf.length === 0) return;
      }
    }
    await audit(ctx, req, 'fs.download', p, { serverId: id });
    return reply
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`)
      .header('content-length', stat.size)
      .type('application/octet-stream')
      .send(Readable.from(chunks()));
  });

  /** Raw-body upload: `PUT …/fs/upload?path=/abs/target` with Content-Type: application/octet-stream. */
  app.put('/api/servers/:id/fs/upload', { bodyLimit: 5 * 1024 ** 3 }, async (req) => {
    const id = sid(req);
    const { path: p } = P.parse(req.query);
    const body = req.body;
    if (!(body instanceof Readable)) throw new HttpError(415, 'send the file as application/octet-stream');
    let offset = 0;
    let pending: Buffer[] = [];
    let size = 0;
    const flush = async () => {
      const buf = Buffer.concat(pending);
      await hub.call(id, 'fs.write', { path: p, data: buf.toString('base64'), offset });
      offset += buf.length;
      pending = [];
      size = 0;
    };
    for await (const chunk of body as AsyncIterable<Buffer>) {
      pending.push(chunk);
      size += chunk.length;
      if (size >= CHUNK) await flush();
    }
    if (size > 0 || offset === 0) await flush(); // also creates empty files
    await audit(ctx, req, 'fs.upload', p, { serverId: id, detail: { bytes: offset } });
    return { ok: true, bytes: offset };
  });

  app.post('/api/servers/:id/fs/mkdir', async (req) => {
    const body = P.parse(req.body);
    await hub.call(sid(req), 'fs.mkdir', body);
    await audit(ctx, req, 'fs.mkdir', body.path, { serverId: sid(req) });
    return { ok: true };
  });
  app.post('/api/servers/:id/fs/rename', async (req) => {
    const body = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(req.body);
    await hub.call(sid(req), 'fs.rename', body);
    await audit(ctx, req, 'fs.rename', body.from, { serverId: sid(req), detail: { to: body.to } });
    return { ok: true };
  });
  app.post('/api/servers/:id/fs/delete', async (req) => {
    const body = z.object({ path: z.string().min(1), recursive: z.boolean().default(false) }).parse(req.body);
    await hub.call(sid(req), 'fs.delete', body);
    await audit(ctx, req, 'fs.delete', body.path, { serverId: sid(req), detail: { recursive: body.recursive } });
    return { ok: true };
  });

  // ── docker ──
  const Cid = z.object({ cid: z.string().regex(/^[\w.-]+$/) });
  app.get('/api/servers/:id/containers', (req) => hub.call(sid(req), 'docker.list', {}));
  app.get('/api/servers/:id/containers/stats', (req) => hub.call(sid(req), 'docker.stats', {}));
  app.get('/api/servers/:id/containers/:cid', (req) => hub.call(sid(req), 'docker.inspect', { id: Cid.parse(req.params).cid }));
  app.get('/api/servers/:id/containers/:cid/logs', (req) => {
    const { tail } = z.object({ tail: z.coerce.number().int().max(5000).default(300) }).parse(req.query);
    return hub.call(sid(req), 'docker.logs', { id: Cid.parse(req.params).cid, tail });
  });
  app.post('/api/servers/:id/containers/:cid/:action', async (req) => {
    const id = sid(req);
    const { cid } = Cid.parse(req.params);
    const { action } = z.object({ action: z.enum(['start', 'stop', 'restart']) }).parse(req.params);
    await hub.call(id, 'docker.action', { id: cid, action }, 120_000);
    await audit(ctx, req, `docker.${action}`, cid, { serverId: id });
    return { ok: true };
  });

  // ── git (read-only views used by the agent workspace) ──
  app.get('/api/servers/:id/git/status', (req) => hub.call(sid(req), 'git.status', z.object({ cwd: z.string() }).parse(req.query)));
  app.get('/api/servers/:id/git/diff', (req) =>
    hub.call(sid(req), 'git.diff', z.object({ cwd: z.string(), path: z.string().optional() }).parse(req.query)));
}
