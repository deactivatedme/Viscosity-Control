export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Same-origin JSON fetch. The session lives in an httpOnly cookie; nothing secret is ever stored in JS. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined || init.raw ? 'POST' : 'GET'),
    credentials: 'same-origin',
    signal: init.signal,
    headers: init.raw ? { 'content-type': 'application/octet-stream' } : init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as Record<string, unknown>;
    const issues = Array.isArray(d.issues) ? ` — ${(d.issues as { path: string; message: string }[]).map((i) => `${i.path}: ${i.message}`).join('; ')}` : '';
    if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup') && typeof window !== 'undefined') window.location.assign('/login');
    throw new ApiError(res.status, `${typeof d.error === 'string' ? d.error : res.statusText}${issues}`, d);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
