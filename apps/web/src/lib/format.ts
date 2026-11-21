export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);
export function duration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
export function ago(date: string | number | Date | null | undefined): string {
  if (!date) return 'never';
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const time = (d: string | number | Date) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dateTime = (d: string | number | Date) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`);
