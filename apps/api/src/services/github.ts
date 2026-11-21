import { HttpError } from '../context';

export interface GithubRepo { fullName: string; private: boolean; defaultBranch: string; cloneUrl: string; description: string | null; pushedAt: string | null }

/** Minimal GitHub REST client. The token only ever travels in the Authorization header. */
export function githubClient(baseUrl: string, token: string) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          'user-agent': 'viscosity-control', ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new HttpError(502, `could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (await res.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
    if (res.ok) return data as T;
    const detail = [data?.message, ...(data?.errors ?? []).map((e) => e.message)].filter(Boolean).join(' — ') || res.statusText;
    // 400 rather than 401: a 401 from our own API would mean "your dashboard session expired".
    if (res.status === 401 || res.status === 403) throw new HttpError(400, `GitHub rejected this token (${res.status}): ${detail}`);
    if (res.status === 404) throw new HttpError(404, `GitHub: not found, or the token cannot see it (${path})`);
    throw new HttpError(res.status === 422 ? 422 : 502, `GitHub: ${detail}`);
  }

  return {
    async repos(): Promise<GithubRepo[]> {
      // shortcut: first 100 repositories by last push; add pagination/search when someone has more
      const rows = await request<{ full_name: string; private: boolean; default_branch: string; clone_url: string; description: string | null; pushed_at: string | null }[]>(
        'GET', '/user/repos?per_page=100&sort=pushed');
      return rows.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, cloneUrl: r.clone_url, description: r.description, pushedAt: r.pushed_at }));
    },
    async createPull(repoFullName: string, pr: { title: string; body?: string; head: string; base: string }): Promise<{ url: string; number: number }> {
      const r = await request<{ html_url: string; number: number }>('POST', `/repos/${repoFullName}/pulls`, pr);
      return { url: r.html_url, number: r.number };
    },
  };
}
