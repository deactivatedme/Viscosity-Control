import { relative } from 'node:path';
import { RpcError } from '@viscosity/protocol';
import type { Ctx, Handlers } from '../context';
import { exec } from '../exec';

const MAX_DIFF = 512 * 1024;
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export const git = (cwd: string, args: string[], timeoutMs = 30_000): Promise<string> =>
  exec('git', ['-C', cwd, ...args], { env, timeoutMs }).then((r) => r.stdout);

export const isRepo = (cwd: string): Promise<boolean> =>
  git(cwd, ['rev-parse', '--is-inside-work-tree']).then(
    (out) => out.trim() === 'true',
    () => false,
  );

export function gitHandlers(ctx: Ctx): Pick<Handlers, 'git.status' | 'git.diff'> {
  return {
    'git.status': async (params) => {
      const cwd = await ctx.guard(params.cwd);
      if (!(await isRepo(cwd))) return { isRepo: false, branch: null, files: [] };
      // -z: NUL-separated, paths unquoted; a rename/copy entry is followed by its original path.
      const entries = (await git(cwd, ['status', '--porcelain=v1', '--branch', '-z'])).split('\0').filter(Boolean);
      const head = entries.shift() ?? '';
      const branch = /^## (?:No commits yet on )?([^.\s]+(?:\.[^.\s]+)*)/.exec(head)?.[1] ?? null;
      const files: { path: string; status: string }[] = [];
      for (let i = 0; i < entries.length; i++) {
        const status = entries[i]!.slice(0, 2);
        files.push({ path: entries[i]!.slice(3), status: status.trim() });
        if (/[RC]/.test(status)) i++;
      }
      return { isRepo: true, branch: branch === 'HEAD' ? null : branch, files };
    },
    'git.diff': async (params) => {
      const cwd = await ctx.guard(params.cwd);
      if (!(await isRepo(cwd))) throw new RpcError('invalid', 'not a git repository');
      const args = ['diff', '--no-color'];
      // An empty repository has no HEAD to diff against.
      if (await git(cwd, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)) args.push('HEAD');
      if (params.path) args.push('--', relative(cwd, await ctx.guard(`${cwd}/${params.path}`)) || '.');
      const diff = await git(cwd, args);
      return { diff: diff.slice(0, MAX_DIFF), truncated: diff.length > MAX_DIFF };
    },
  };
}
