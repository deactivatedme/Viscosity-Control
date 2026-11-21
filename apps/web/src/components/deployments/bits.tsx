import { StatusDot } from '@/components/ui/bits';
import { cn } from '@/lib/cn';

/** Deployment and release states, drawn with the shared monochrome status shapes. */
const LOOK: Record<string, { dot: string; label: string }> = {
  idle: { dot: 'stopped', label: 'Not running' },
  pending_approval: { dot: 'waiting_approval', label: 'Needs approval' },
  deploying: { dot: 'running', label: 'Deploying' },
  running: { dot: 'running', label: 'Deploying' },
  healthy: { dot: 'online', label: 'Healthy' },
  unhealthy: { dot: 'failed', label: 'Unhealthy' },
  failed: { dot: 'failed', label: 'Failed' },
  succeeded: { dot: 'completed', label: 'Succeeded' },
  rejected: { dot: 'stopped', label: 'Rejected' },
};
export function DeployStatus({ status, className }: { status: string; className?: string }) {
  const look = LOOK[status] ?? { dot: 'stopped', label: status };
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-fg-2', className)}><StatusDot status={look.dot} />{look.label}</span>;
}

/** Production is the loud one: solid. Staging is outlined. */
export function EnvBadge({ environment }: { environment: 'staging' | 'production' }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded px-1.5 font-mono text-2xs uppercase tracking-wider',
      environment === 'production' ? 'bg-fg text-bg' : 'border border-line-strong text-fg-3')}>{environment}</span>
  );
}
export const shortSha = (v: string | null | undefined) => (v ? (/^[0-9a-f]{40}$/.test(v) ? v.slice(0, 8) : v) : '—');
