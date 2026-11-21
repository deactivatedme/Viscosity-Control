/** One JSON line per event on stderr — journald/docker friendly. Never pass credentials in `fields`. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
