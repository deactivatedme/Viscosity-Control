import { lstat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { RpcError } from '@viscosity/protocol';

export type PathGuard = (path: string) => Promise<string>;

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/**
 * Returns a resolver that canonicalises a path (following symlinks) and rejects anything
 * outside `roots`. For targets that do not exist yet, the deepest existing ancestor is
 * canonicalised instead, so `fs.write` of a new file cannot escape through a symlinked parent.
 * shortcut: check-then-use is racy against a local user swapping a symlink in between;
 * upgrade to openat2(RESOLVE_BENEATH) if untrusted local users share the roots.
 */
export function createPathGuard(roots: string[]): PathGuard {
  const realRoots = roots.map((r) => realpathSync(r));
  return async (path) => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
      throw new RpcError('invalid', 'path must be absolute');
    }
    let current = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try {
        current = await realpath(current);
        break;
      } catch (err) {
        if (code(err) !== 'ENOENT' && code(err) !== 'ENOTDIR') throw new RpcError('failed', (err as Error).message);
        // A dangling symlink "does not exist" for realpath but a write would follow it.
        const link = await lstat(current).catch(() => null);
        if (link?.isSymbolicLink()) throw new RpcError('forbidden', `dangling symlink: ${path}`);
        const parent = dirname(current);
        if (parent === current) throw new RpcError('not_found', path);
        missing.unshift(basename(current));
        current = parent;
      }
    }
    const full = join(current, ...missing);
    if (!realRoots.some((root) => full === root || full.startsWith(root + sep))) {
      throw new RpcError('forbidden', `path is outside the allowed roots: ${path}`);
    }
    return full;
  };
}
