import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, HttpError, me, type Ctx } from '../context';
import { schema } from '../db';
import type { AgentService } from '../services/agents';
import { githubClient } from '../services/github';

const Id = z.object({ id: z.string().uuid() });
const Ref = z.string().regex(/^[\w./@-]+$/).max(200);
const Path = z.string().min(1).max(4096);
const CLONE_TIMEOUT = 16 * 60_000;
const GIT_TIMEOUT = 6 * 60_000;

const Create = z.object({
  serverId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  path: Path,
  mode: z.enum(['clone', 'existing']),
  cloneUrl: z.string().url().optional(),
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200).optional(),
  branch: Ref.optional(),
  credentialId: z.string().uuid().optional(),
});

/**
 * The custom adapter appends the session prompt as a final argument. This POSIX wrapper
 * drops that last argument and execs the rest, so the command runs exactly as typed
 * (arguments stay separate words — nothing here is parsed by a shell).
 */
const DROP_LAST_ARG = 'c=$#; n=$#; for a do if [ "$n" -gt 1 ]; then set -- "$@" "$a"; fi; n=$((n-1)); done; shift "$c"; exec "$@"';

/** Projects (source trees on servers) and their GitHub integration. */
export function projectRoutes(app: FastifyInstance, ctx: Ctx, agents: AgentService) {
  const { db, hub, box, config } = ctx;
  const P = schema.projects;
  type Row = typeof P.$inferSelect;

  async function get(req: FastifyRequest): Promise<Row> {
    const [row] = await db.select().from(P).where(eq(P.id, Id.parse(req.params).id));
    if (!row) throw new HttpError(404, 'project not found');
    return row;
  }
  /** The GitHub token behind a credential id, or undefined when none is attached. */
  async function tokenOf(credentialId: string | null | undefined): Promise<string | undefined> {
    if (!credentialId) return undefined;
    const [cred] = await db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId));
    if (!cred) throw new HttpError(400, 'the selected credential no longer exists');
    if (cred.kind !== 'github') throw new HttpError(400, 'choose a GitHub credential');
    return box.decrypt(cred.secretEnc);
  }
  const view = (p: Row) => ({ ...p, serverOnline: hub.isOnline(p.serverId) });
  /** Branch + number of changed files, or null when the tree cannot be read right now. */
  async function summary(p: Row) {
    if (!hub.isOnline(p.serverId)) return null;
    try {
      const s = await hub.call(p.serverId, 'git.status', { cwd: p.path }, 8000);
      // "not a repository" is also what a deleted directory looks like to git; tell the two apart.
      if (!s.isRepo) await hub.call(p.serverId, 'fs.stat', { path: p.path }, 8000);
      return { isRepo: s.isRepo, branch: s.branch, changed: s.files.length };
    } catch {
      return null; // directory removed or worker busy: the list still renders, the detail view shows the real error
    }
  }

  app.get('/api/github/repos', async (req) => {
    const { credentialId } = z.object({ credentialId: z.string().uuid() }).parse(req.query);
    return githubClient(config.githubApiUrl, (await tokenOf(credentialId))!).repos();
  });

  app.get('/api/projects', async () => {
    const rows = await db.select().from(P).orderBy(desc(P.createdAt));
    return Promise.all(rows.map(async (p) => ({ ...view(p), git: await summary(p) })));
  });

  app.get('/api/projects/:id', async (req) => {
    const p = await get(req);
    return { ...view(p), git: await summary(p) };
  });

  app.post('/api/projects', async (req) => {
    const body = Create.parse(req.body);
    const [server] = await db.select().from(schema.servers).where(eq(schema.servers.id, body.serverId));
    if (!server) throw new HttpError(404, 'server not found');
    const [dup] = await db.select().from(P).where(and(eq(P.serverId, body.serverId), eq(P.path, body.path)));
    if (dup) throw new HttpError(409, `"${dup.name}" already uses ${body.path} on this server`);
    const token = await tokenOf(body.credentialId);

    if (body.mode === 'clone') {
      if (!body.cloneUrl) throw new HttpError(400, 'a clone URL is required');
      await hub.call(body.serverId, 'git.clone', { url: body.cloneUrl, dest: body.path, branch: body.branch, token }, CLONE_TIMEOUT);
    } else {
      const stat = await hub.call(body.serverId, 'fs.stat', { path: body.path });
      if (stat.type !== 'dir') throw new HttpError(400, `${body.path} is not a directory`);
    }
    const status = await hub.call(body.serverId, 'git.status', { cwd: body.path });
    const [row] = await db.insert(P).values({
      name: body.name, serverId: body.serverId, path: body.path, repoFullName: body.repoFullName ?? null, cloneUrl: body.cloneUrl ?? null,
      defaultBranch: status.branch, credentialId: body.credentialId ?? null, createdBy: me(req).id,
    }).returning();
    await audit(ctx, req, 'project.create', body.name, { serverId: body.serverId, detail: { mode: body.mode, path: body.path, cloneUrl: body.cloneUrl, repo: body.repoFullName } });
    return view(row!);
  });

  app.delete('/api/projects/:id', async (req) => {
    const p = await get(req);
    const { deleteFiles } = z.object({ deleteFiles: z.boolean().default(false) }).parse(req.body ?? {});
    if (deleteFiles) await hub.call(p.serverId, 'fs.delete', { path: p.path, recursive: true }, 120_000);
    await db.delete(P).where(eq(P.id, p.id));
    await audit(ctx, req, 'project.delete', p.name, { serverId: p.serverId, detail: { path: p.path, deleteFiles } });
    return { ok: true };
  });

  // ── read-only git views ──
  app.get('/api/projects/:id/status', async (req) => { const p = await get(req); return hub.call(p.serverId, 'git.status', { cwd: p.path }); });
  app.get('/api/projects/:id/branches', async (req) => { const p = await get(req); return hub.call(p.serverId, 'git.branches', { cwd: p.path }); });
  app.get('/api/projects/:id/worktrees', async (req) => { const p = await get(req); return hub.call(p.serverId, 'git.worktrees', { cwd: p.path }); });
  app.get('/api/projects/:id/commits', async (req) => {
    const p = await get(req);
    const q = z.object({ ref: Ref.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return hub.call(p.serverId, 'git.log', { cwd: p.path, ...q });
  });
  app.get('/api/projects/:id/diff', async (req) => {
    const p = await get(req);
    const { path } = z.object({ path: z.string().max(4096).optional() }).parse(req.query);
    return hub.call(p.serverId, 'git.diff', { cwd: p.path, path });
  });

  // ── git mutations ──
  app.post('/api/projects/:id/checkout', async (req) => {
    const p = await get(req);
    const body = z.object({ ref: Ref, create: z.boolean().default(false) }).parse(req.body);
    await hub.call(p.serverId, 'git.checkout', { cwd: p.path, ...body });
    await audit(ctx, req, 'project.checkout', p.name, { serverId: p.serverId, detail: body });
    return { ok: true };
  });
  app.post('/api/projects/:id/pull', async (req) => {
    const p = await get(req);
    await hub.call(p.serverId, 'git.pull', { cwd: p.path, token: await tokenOf(p.credentialId) }, GIT_TIMEOUT);
    await audit(ctx, req, 'project.pull', p.name, { serverId: p.serverId });
    return { ok: true };
  });
  app.post('/api/projects/:id/commit', async (req) => {
    const p = await get(req);
    const { message } = z.object({ message: z.string().trim().min(1).max(5000) }).parse(req.body);
    const r = await hub.call(p.serverId, 'git.commit', { cwd: p.path, message });
    await audit(ctx, req, 'project.commit', p.name, { serverId: p.serverId, detail: { sha: r.sha } });
    return r;
  });
  app.post('/api/projects/:id/push', async (req) => {
    const p = await get(req);
    const { branch } = z.object({ branch: Ref }).parse(req.body);
    await hub.call(p.serverId, 'git.push', { cwd: p.path, branch, token: await tokenOf(p.credentialId) }, GIT_TIMEOUT);
    await audit(ctx, req, 'project.push', p.name, { serverId: p.serverId, detail: { branch } });
    return { ok: true };
  });
  app.post('/api/projects/:id/worktrees', async (req) => {
    const p = await get(req);
    const { branch } = z.object({ branch: Ref }).parse(req.body);
    const r = await hub.call(p.serverId, 'git.worktreeAdd', { cwd: p.path, branch });
    await audit(ctx, req, 'project.worktree_add', p.name, { serverId: p.serverId, detail: { branch, path: r.path } });
    return r;
  });
  app.delete('/api/projects/:id/worktrees', async (req) => {
    const p = await get(req);
    const { path } = z.object({ path: Path }).parse(req.body);
    await hub.call(p.serverId, 'git.worktreeRemove', { cwd: p.path, path });
    await audit(ctx, req, 'project.worktree_remove', p.name, { serverId: p.serverId, detail: { path } });
    return { ok: true };
  });

  /** Run a build/test command as a supervised session (streamed, stoppable, kept in history). */
  app.post('/api/projects/:id/run', async (req) => {
    const p = await get(req);
    const body = z.object({ command: z.array(z.string().max(4096)).min(1).max(64), name: z.string().trim().min(1).max(80).optional() }).parse(req.body);
    const label = body.name ?? body.command.join(' ');
    const session = await agents.create({
      serverId: p.serverId, provider: 'custom', cwd: p.path, permissionMode: 'auto', name: `${p.name}: ${label}`.slice(0, 80),
      command: ['sh', '-c', DROP_LAST_ARG, 'sh', ...body.command], prompt: label,
    }, me(req).id, `project:${p.id}`);
    await audit(ctx, req, 'project.run', p.name, { serverId: p.serverId, detail: { command: body.command, sessionId: session.id } });
    return session;
  });

  /** Push the head branch, then open a pull request on GitHub. */
  app.post('/api/projects/:id/pull-request', async (req) => {
    const p = await get(req);
    const body = z.object({ title: z.string().trim().min(1).max(256), body: z.string().max(60_000).optional(), head: Ref, base: Ref }).parse(req.body);
    if (!p.repoFullName) throw new HttpError(400, 'this project is not linked to a GitHub repository');
    const token = await tokenOf(p.credentialId);
    if (!token) throw new HttpError(400, 'this project has no GitHub credential; pull requests need one');
    if (body.head === body.base) throw new HttpError(400, 'the head and base branches are the same');
    await hub.call(p.serverId, 'git.push', { cwd: p.path, branch: body.head, token }, GIT_TIMEOUT);
    const pr = await githubClient(config.githubApiUrl, token).createPull(p.repoFullName, body);
    await audit(ctx, req, 'project.pull_request', p.name, { serverId: p.serverId, detail: { head: body.head, base: body.base, url: pr.url } });
    return pr;
  });
}
