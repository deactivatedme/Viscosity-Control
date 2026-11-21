import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { RpcError } from '@viscosity/protocol';
import { OK, type Ctx, type Handlers } from '../context';
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

/**
 * Per-invocation HTTPS auth. The token goes through the environment (not argv, so it is not
 * visible in the process list) and is never written to .git/config or the remote URL.
 */
function authEnv(token?: string): NodeJS.ProcessEnv {
  if (!token) return env;
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: header };
}
const gitAuth = (cwd: string, args: string[], token: string | undefined, timeoutMs: number) =>
  exec('git', ['-C', cwd, ...args], { env: authEnv(token), timeoutMs }).then((r) => r.stdout);

/** A ref that starts with "-" would be parsed by git as an option. */
function safeRef(ref: string): string {
  if (ref.startsWith('-')) throw new RpcError('invalid', `invalid ref: ${ref}`);
  return ref;
}
async function repo(ctx: Ctx, dir: string): Promise<string> {
  const cwd = await ctx.guard(dir);
  if (!(await isRepo(cwd))) throw new RpcError('invalid', 'not a git repository');
  return cwd;
}
const hasRef = (cwd: string, ref: string) => git(cwd, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);

type GitMethods = 'git.status' | 'git.diff' | 'git.clone' | 'git.branches' | 'git.log' | 'git.checkout' | 'git.commit' | 'git.push' | 'git.pull' | 'git.worktrees' | 'git.worktreeAdd' | 'git.worktreeRemove';

export function gitHandlers(ctx: Ctx): Pick<Handlers, GitMethods> {
  return {
    'git.clone': async ({ url, dest, branch, token }) => {
      if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new RpcError('invalid', 'only http(s) clone URLs are supported');
      const target = await ctx.guard(dest);
      if (existsSync(target) && readdirSync(target).length > 0) throw new RpcError('invalid', `${target} already exists and is not empty`);
      const args = ['clone', '--quiet'];
      if (branch) args.push('--branch', safeRef(branch));
      await exec('git', [...args, '--', url, target], { env: authEnv(token), timeoutMs: 15 * 60_000 });
      return OK;
    },
    'git.branches': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      const out = await git(cwd, ['for-each-ref', '--format=%(refname)%1f%(objectname:short)%1f%(HEAD)', 'refs/heads', 'refs/remotes']);
      return out.split('\n').filter(Boolean).flatMap((line) => {
        const [ref = '', sha = '', head = ''] = line.split('\x1f');
        const remote = ref.startsWith('refs/remotes/');
        const name = ref.replace(/^refs\/(heads|remotes)\//, '');
        return name.endsWith('/HEAD') ? [] : [{ name, sha, remote, current: head === '*' }];
      });
    },
    'git.log': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      if (!(await hasRef(cwd, 'HEAD'))) return []; // no commits yet
      const args = ['log', `-n${params.limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s'];
      if (params.ref) args.push(safeRef(params.ref));
      const out = await git(cwd, [...args, '--']);
      return out.split('\n').filter(Boolean).map((line) => {
        const [sha = '', author = '', date = '', subject = ''] = line.split('\x1f');
        return { sha, author, date, subject };
      });
    },
    'git.checkout': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      await git(cwd, params.create ? ['checkout', '-b', safeRef(params.ref)] : ['checkout', safeRef(params.ref), '--']);
      return OK;
    },
    'git.commit': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      await git(cwd, ['add', '-A']);
      if (!(await git(cwd, ['status', '--porcelain'])).trim()) throw new RpcError('invalid', 'nothing to commit: the working tree is clean');
      // Use the repository's identity when it has one; otherwise commit as the control plane.
      const identity = (await git(cwd, ['config', 'user.email']).catch(() => '')).trim()
        ? [] : ['-c', 'user.name=VISCOSITY CONTROL', '-c', 'user.email=viscosity-control@localhost'];
      await git(cwd, [...identity, 'commit', '--quiet', '-m', params.message]);
      return { sha: (await git(cwd, ['rev-parse', 'HEAD'])).trim() };
    },
    'git.push': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      await gitAuth(cwd, ['push', '--quiet', '-u', 'origin', safeRef(params.branch)], params.token, 5 * 60_000);
      return OK;
    },
    'git.pull': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      await gitAuth(cwd, ['pull', '--quiet', '--ff-only'], params.token, 5 * 60_000);
      return OK;
    },
    'git.worktrees': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      const blocks = (await git(cwd, ['worktree', 'list', '--porcelain'])).split('\n\n').filter((b) => b.trim());
      return blocks.map((b) => ({
        path: /^worktree (.+)$/m.exec(b)?.[1] ?? '',
        sha: (/^HEAD (.+)$/m.exec(b)?.[1] ?? '').slice(0, 12),
        branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
      }));
    },
    'git.worktreeAdd': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      const branch = safeRef(params.branch);
      const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
      const path = await ctx.guard(join(dirname(top), '.viscosity-worktrees', `${basename(top)}-${branch.replace(/[^\w.-]+/g, '-')}`));
      await git(cwd, (await hasRef(cwd, `refs/heads/${branch}`)) ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path]);
      return { path };
    },
    'git.worktreeRemove': async (params) => {
      const cwd = await repo(ctx, params.cwd);
      await git(cwd, ['worktree', 'remove', '--force', await ctx.guard(params.path)]);
      return OK;
    },
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
