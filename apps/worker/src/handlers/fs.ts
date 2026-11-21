import { readFileSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RpcError, type FsEntry } from '@viscosity/protocol';
import { OK, type Ctx, type Handlers } from '../context';

const SEARCH_SKIP = new Set(['node_modules', '.git']);
const SEARCH_MAX_VISITED = 50_000;

let users: Map<number, string> | null = null;
function owner(uid: number): string {
  if (!users) {
    users = new Map();
    try {
      for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id) users.set(Number(id), name);
      }
    } catch {
      // No passwd database (unusual container): numeric uids are shown instead.
    }
  }
  return users.get(uid) ?? String(uid);
}

function modeString(mode: number): string {
  return [...'rwxrwxrwx'].map((ch, i) => (mode & (0o400 >> i) ? ch : '-')).join('');
}

function entry(path: string, st: Stats): FsEntry {
  return {
    name: basename(path),
    path,
    type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
    size: st.size,
    mtime: st.mtimeMs,
    mode: modeString(st.mode),
    owner: owner(st.uid),
  };
}

/** Map errno to protocol codes so the dashboard can show "not found" vs "permission denied". */
function fsError(err: unknown): never {
  if (err instanceof RpcError) throw err;
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') throw new RpcError('not_found', e.message);
  if (e.code === 'EACCES' || e.code === 'EPERM') throw new RpcError('forbidden', e.message);
  throw new RpcError('failed', e.message);
}

type FsMethods = 'fs.list' | 'fs.stat' | 'fs.read' | 'fs.write' | 'fs.mkdir' | 'fs.rename' | 'fs.delete' | 'fs.search';

export function fsHandlers(ctx: Ctx): Pick<Handlers, FsMethods> {
  const wrap = <P, R>(fn: (params: P) => Promise<R>) => (params: P): Promise<R> => fn(params).catch(fsError);
  return {
    'fs.list': wrap(async ({ path }) => {
      const dir = await ctx.guard(path);
      const names = await readdir(dir);
      const entries = await Promise.all(names.map(async (name) => entry(join(dir, name), await lstat(join(dir, name)))));
      return entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
    }),
    'fs.stat': wrap(async ({ path }) => {
      const full = await ctx.guard(path);
      return entry(full, await stat(full));
    }),
    'fs.read': wrap(async ({ path, offset, length }) => {
      const handle = await open(await ctx.guard(path), 'r');
      try {
        const { size } = await handle.stat();
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        return { data: buf.subarray(0, bytesRead).toString('base64'), size, eof: offset + bytesRead >= size };
      } finally {
        await handle.close();
      }
    }),
    'fs.write': wrap(async ({ path, data, offset }) => {
      const full = await ctx.guard(path);
      const buf = Buffer.from(data, 'base64');
      if (offset === 0) {
        await writeFile(full, buf);
      } else {
        const handle = await open(full, 'r+');
        try {
          await handle.write(buf, 0, buf.length, offset);
        } finally {
          await handle.close();
        }
      }
      return OK;
    }),
    'fs.mkdir': wrap(async ({ path }) => {
      await mkdir(await ctx.guard(path), { recursive: true });
      return OK;
    }),
    'fs.rename': wrap(async ({ from, to }) => {
      await rename(await ctx.guard(from), await ctx.guard(to));
      return OK;
    }),
    'fs.delete': wrap(async ({ path, recursive }) => {
      const full = await ctx.guard(path);
      for (const root of ctx.config.roots) {
        if (full === (await ctx.guard(root))) throw new RpcError('forbidden', 'refusing to delete an allowed root');
      }
      const st = await lstat(full);
      if (st.isDirectory() && !recursive) await rmdir(full); // fails with ENOTEMPTY rather than deleting contents
      else await rm(full, { recursive });
      return OK;
    }),
    'fs.search': wrap(async ({ path, query, limit }) => {
      const needle = query.toLowerCase();
      const queue = [await ctx.guard(path)];
      const hits: FsEntry[] = [];
      let visited = 0;
      // Breadth-first so shallow matches come first; symlinks are reported but never followed.
      while (queue.length && hits.length < limit && visited < SEARCH_MAX_VISITED) {
        const dir = queue.shift()!;
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []); // unreadable subdirs are skipped
        for (const d of dirents) {
          visited++;
          const full = join(dir, d.name);
          if (d.name.toLowerCase().includes(needle)) {
            hits.push(entry(full, await lstat(full)));
            if (hits.length >= limit) break;
          }
          if (d.isDirectory() && !SEARCH_SKIP.has(d.name)) queue.push(full);
        }
      }
      return hits;
    }),
  };
}
