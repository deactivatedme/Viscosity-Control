import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Monochrome status language — state is carried by shape and motion, never colour:
 * live = solid dot with a slow ring, working = spinning arc, idle/done = solid dim dot,
 * waiting = half-filled, off/failed = hollow ring / cross.
 */
const STATUS: Record<string, { label: string; look: 'live' | 'busy' | 'done' | 'wait' | 'off' | 'bad' }> = {
  online: { label: 'Online', look: 'live' }, offline: { label: 'Offline', look: 'off' }, pending: { label: 'Not enrolled', look: 'wait' },
  queued: { label: 'Queued', look: 'wait' }, starting: { label: 'Starting', look: 'busy' }, running: { label: 'Running', look: 'busy' },
  waiting_approval: { label: 'Needs approval', look: 'wait' }, completed: { label: 'Completed', look: 'done' }, failed: { label: 'Failed', look: 'bad' },
  stopped: { label: 'Stopped', look: 'off' }, lost: { label: 'Lost', look: 'bad' }, open: { label: 'Open', look: 'live' }, closed: { label: 'Closed', look: 'off' },
  exited: { label: 'Exited', look: 'off' }, paused: { label: 'Paused', look: 'wait' }, restarting: { label: 'Restarting', look: 'busy' }, created: { label: 'Created', look: 'wait' }, dead: { label: 'Dead', look: 'bad' },
};
export const statusLabel = (s: string) => STATUS[s]?.label ?? s;

export function StatusDot({ status, className }: { status: string; className?: string }) {
  const look = STATUS[status]?.look ?? 'off';
  if (look === 'busy') return <Loader2 aria-hidden className={cn('size-3 animate-spin text-fg', className)} />;
  return (
    <span aria-hidden className={cn('relative inline-block size-2 shrink-0 rounded-full', className,
      look === 'live' && 'bg-fg animate-pulse-ring',
      look === 'done' && 'bg-fg-3',
      look === 'off' && 'border border-fg-3',
      look === 'wait' && 'border border-fg-2 bg-[linear-gradient(90deg,var(--color-fg-2)_50%,transparent_50%)]',
      look === 'bad' && 'border border-fg bg-[linear-gradient(45deg,transparent_42%,var(--color-fg)_42%,var(--color-fg)_58%,transparent_58%)]',
    )} />
  );
}
export function Status({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm text-fg-2', className)}>
      <StatusDot status={status} />
      {statusLabel(status)}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-5 items-center rounded border border-line-strong px-1.5 font-mono text-2xs uppercase tracking-wider text-fg-3', className)}>{children}</span>;
}
export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-bg px-1 font-mono text-2xs text-fg-3">{children}</kbd>
);

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn('skeleton h-4', className)} />;
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-8" />)}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-line-strong bg-raised"><Icon className="size-5 text-fg-2" strokeWidth={1.5} /></div>
      <h3 className="text-[15px] font-medium tracking-tight">{title}</h3>
      {children ? <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-3">{children}</p> : null}
      {action ? <div className="mt-5 flex gap-2">{action}</div> : null}
    </div>
  );
}

/** Shown when a query fails — the real error, with a retry. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 rounded-lg border border-line-strong bg-panel p-4">
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="mt-1 break-words font-mono text-xs text-fg-2">{error instanceof Error ? error.message : String(error)}</p>
      {onRetry ? <button onClick={onRetry} className="mt-3 text-sm text-fg underline underline-offset-4 hover:no-underline">Try again</button> : null}
    </div>
  );
}

/** Page chrome shared by every view. */
export function View({ title, subtitle, actions, children, flush }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <div className="@container flex h-full min-w-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-medium tracking-tight">{title}</h1>
          {subtitle ? <div className="truncate text-xs text-fg-3">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn('min-h-0 flex-1 overflow-auto', !flush && 'p-4')}>{children}</div>
    </div>
  );
}

export function Sparkline({ values, max, className }: { values: number[]; max?: number; className?: string }) {
  if (values.length < 2) return <svg className={className} aria-hidden />;
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - (v / top) * 26}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn('h-8 w-full', className)} aria-hidden>
      <polygon points={`0,30 ${pts} 100,30`} fill="rgb(255 255 255 / 0.06)" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function Meter({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-active', className)} role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-fg-2 transition-[width] duration-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="inline-flex rounded-md border border-line-strong bg-bg p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('h-6 rounded px-2.5 text-sm transition-colors', value === o.value ? 'bg-active text-fg' : 'text-fg-3 hover:text-fg-2')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cn('sticky top-0 z-10 border-b bg-panel px-3 py-2 text-left text-xs font-normal uppercase tracking-wider text-fg-3', className)}>{children}</th>
);
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={cn('border-b px-3 py-2 align-middle', className)}>{children}</td>;
