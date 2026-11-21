import type { GitBranch, GitCommit, GitStatus, GitWorktree } from '@viscosity/protocol';

export interface Project {
  id: string; name: string; serverId: string; path: string; repoFullName: string | null; cloneUrl: string | null;
  defaultBranch: string | null; credentialId: string | null; createdAt: string; serverOnline: boolean;
  /** Live working-tree summary; null when the server is offline or the directory cannot be read. */
  git: { isRepo: boolean; branch: string | null; changed: number } | null;
}
export interface GithubRepo { fullName: string; private: boolean; defaultBranch: string; cloneUrl: string; description: string | null; pushedAt: string | null }
export type { GitBranch, GitCommit, GitStatus, GitWorktree };

/**
 * Split a command line into argv without involving a shell: whitespace separates words,
 * single/double quotes group them, backslash escapes the next character. No expansion of any kind.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false; // distinguishes an empty quoted word ("") from no word at all
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; started = true; }
    else if (/\s/.test(c)) { if (cur || started) { out.push(cur); cur = ''; started = false; } }
    else cur += c;
  }
  if (quote) throw new Error(`unterminated ${quote} quote`);
  if (cur || started) out.push(cur);
  return out;
}
