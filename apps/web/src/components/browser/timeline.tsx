'use client';
import { Ban, Camera, Check, Copy, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { time } from '@/lib/format';
import { statusLabel } from '@/components/ui/bits';
import type { BrowserEnvelope } from '@/lib/types';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button aria-label={label} onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="flex size-6 shrink-0 items-center justify-center rounded-md border border-line-strong bg-raised text-fg-2 transition-colors hover:text-fg">
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/** Marker column: outcome is carried by shape (filled check / outlined cross), never colour. */
function Mark({ ok }: { ok: boolean }) {
  return ok
    ? <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-fg text-bg" aria-label="succeeded"><Check className="size-2.5" strokeWidth={3} /></span>
    : <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-fg" aria-label="failed"><X className="size-2.5" strokeWidth={3} /></span>;
}

function Entry({ env, pending, pinned, onPin, onDecide }: {
  env: BrowserEnvelope; pending: boolean; pinned: boolean; onPin: (seq: number) => void; onDecide: (approvalId: string, decision: 'allow' | 'deny') => Promise<void>;
}) {
  const ev = env.event;
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const stamp = <time className="tnum shrink-0 font-mono text-2xs text-fg-4">{time(env.ts)}</time>;

  switch (ev.type) {
    case 'status':
      return (
        <li className="flex items-center gap-3 py-1 text-2xs uppercase tracking-[0.14em] text-fg-3">
          <span className="h-px flex-1 bg-line" />{statusLabel(ev.status)}{ev.detail ? <span className="normal-case tracking-normal">— {ev.detail}</span> : null}<span className="h-px flex-1 bg-line" />
        </li>
      );
    case 'action':
      return (
        <li className="flex gap-2.5">
          <Mark ok={ev.ok} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs font-medium">{ev.action}</span>
              <span className="min-w-0 flex-1 break-words font-mono text-xs text-fg-2">{ev.detail}</span>
              {stamp}
            </div>
            {ev.verified ? <p className="mt-0.5 text-xs text-fg-3">Verified: {ev.verified}</p> : null}
            {ev.error ? <p role="alert" className="mt-1 break-words rounded-md border border-line-strong bg-bg px-2 py-1 font-mono text-xs">{ev.error}</p> : null}
            {ev.url ? <p className="mt-0.5 truncate font-mono text-2xs text-fg-4" title={ev.url}>{ev.title ? `${ev.title} · ` : ''}{ev.url}</p> : null}
          </div>
        </li>
      );
    case 'screenshot':
      return (
        <li>
          <button onClick={() => onPin(env.seq)} aria-pressed={pinned}
            className={cn('flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-raised', pinned ? 'border-fg-3 bg-raised' : 'border-transparent')}>
            <Camera className="size-4 shrink-0 text-fg-3" strokeWidth={1.6} />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2">Screenshot{pinned ? ' — pinned' : ''}<span className="ml-2 font-mono text-2xs text-fg-4">{ev.url}</span></span>
            {stamp}
          </button>
        </li>
      );
    case 'blocked':
      return (
        <li className="flex gap-2.5">
          <Ban className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2"><span className="text-xs font-medium">Request blocked</span><span className="flex-1" />{stamp}</div>
            <p className="break-all font-mono text-xs text-fg-2">{ev.url}</p>
            <p className="text-xs text-fg-3">{ev.reason}</p>
          </div>
        </li>
      );
    case 'text':
      return <li className="flex gap-2.5"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-3" /><p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-2">{ev.text}</p>{stamp}</li>;
    case 'approval_request':
      return (
        <li className={cn('rounded-lg border p-3', pending ? 'border-fg-3 bg-raised' : 'border-line-strong')}>
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="text-sm font-medium">Approval requested</span><span className="flex-1" />{stamp}</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-2">{ev.reason}</p>
              {pending ? (
                <div className="mt-2.5 flex gap-2">
                  {(['allow', 'deny'] as const).map((d) => (
                    <Button key={d} size="sm" variant={d === 'allow' ? 'primary' : 'secondary'} loading={busy === d} disabled={busy !== null}
                      onClick={async () => { setBusy(d); try { await onDecide(ev.approvalId, d); } finally { setBusy(null); } }}>
                      {d === 'allow' ? 'Allow' : 'Deny'}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </li>
      );
    case 'approval_resolved':
      return <li className="flex gap-2.5"><Mark ok={ev.decision === 'allow'} /><span className="flex-1 text-xs text-fg-2">Approval {ev.decision === 'allow' ? 'granted' : 'denied'}</span>{stamp}</li>;
    case 'result': {
      const data = ev.data == null ? null : JSON.stringify(ev.data, null, 2);
      return (
        <li className="rounded-lg border border-line-strong bg-panel p-3">
          <div className="flex items-start gap-2.5">
            <Mark ok={ev.ok} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="text-sm font-medium">{ev.ok ? 'Result' : 'Did not complete'}</span><span className="flex-1" />{stamp}</div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-2">{ev.summary}</p>
            </div>
          </div>
          {data ? (
            <div className="relative mt-2.5">
              <pre className="max-h-64 overflow-auto rounded-md border border-line-strong bg-bg p-2.5 pr-10 font-mono text-xs leading-relaxed text-fg-2">{data}</pre>
              <div className="absolute right-2 top-2"><CopyButton text={data} label="Copy extracted data" /></div>
            </div>
          ) : null}
        </li>
      );
    }
    case 'error':
      return <li className="flex gap-2.5"><Mark ok={false} /><p role="alert" className="min-w-0 flex-1 break-words font-mono text-xs">{ev.message}</p>{stamp}</li>;
  }
}

export function Timeline({ events, pendingIds, pinned, onPin, onDecide }: {
  events: BrowserEnvelope[]; pendingIds: Set<string>; pinned: number | null; onPin: (seq: number) => void;
  onDecide: (approvalId: string, decision: 'allow' | 'deny') => Promise<void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Follow new events unless the user has scrolled up to read.
  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [events.length]);
  return (
    <div ref={box} className="h-full overflow-y-auto p-3"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {events.length === 0 ? <p className="px-1 py-6 text-center text-sm text-fg-3">No events yet. Actions appear here the moment the worker reports them.</p> : (
        <ol className="space-y-2.5" aria-label="Execution timeline">
          {events.map((env) => (
            <Entry key={env.seq} env={env} pinned={pinned === env.seq} onPin={onPin} onDecide={onDecide}
              pending={env.event.type === 'approval_request' && pendingIds.has(env.event.approvalId)} />
          ))}
        </ol>
      )}
    </div>
  );
}
