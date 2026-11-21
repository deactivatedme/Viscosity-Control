'use client';
import { ArrowDown, Check, ChevronRight, ShieldQuestion, TerminalSquare, Wrench, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { AgentEvent } from '@viscosity/protocol';
import { statusLabel } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { duration, time, usd } from '@/lib/format';
import type { AgentEnvelope, Approval } from '@/lib/types';

type Ev<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;
export type Item =
  | { kind: 'event'; seq: number; ts: number; event: Exclude<AgentEvent, { type: 'tool_use' | 'tool_result' | 'output' }> }
  | { kind: 'tool'; seq: number; ts: number; use: Ev<'tool_use'>; result?: Ev<'tool_result'> }
  | { kind: 'orphan_result'; seq: number; ts: number; result: Ev<'tool_result'> }
  | { kind: 'output'; seq: number; ts: number; stream: 'stdout' | 'stderr'; text: string };

/** Pair tool calls with their results and coalesce consecutive output chunks. */
export function buildItems(events: AgentEnvelope[]): Item[] {
  const results = new Map<string, Ev<'tool_result'>>();
  const uses = new Set<string>();
  for (const { event } of events) {
    if (event.type === 'tool_result') results.set(event.id, event);
    else if (event.type === 'tool_use') uses.add(event.id);
  }
  const items: Item[] = [];
  for (const { seq, ts, event } of events) {
    const last = items.at(-1);
    if (event.type === 'output') {
      if (last?.kind === 'output' && last.stream === event.stream) last.text += event.text;
      else items.push({ kind: 'output', seq, ts, stream: event.stream, text: event.text });
    } else if (event.type === 'tool_use') items.push({ kind: 'tool', seq, ts, use: event, result: results.get(event.id) });
    else if (event.type === 'tool_result') { if (!uses.has(event.id)) items.push({ kind: 'orphan_result', seq, ts, result: event }); }
    else items.push({ kind: 'event', seq, ts, event });
  }
  return items;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
/** The one line worth showing for a tool call: its command, path, pattern or query. */
export function toolSummary(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  return str(i.command) ?? str(i.file_path) ?? str(i.path) ?? str(i.notebook_path) ?? str(i.pattern) ?? str(i.query) ?? str(i.url) ?? str(i.description) ?? '';
}
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

const mono = 'overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-panel px-3 py-2 font-mono text-xs leading-relaxed';

/** Plain text with ``` fenced blocks rendered as code. Deliberately not a markdown renderer. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g);
  return (
    <div className="space-y-2">
      {parts.map((p, i) => i % 2 === 1
        ? <pre key={i} className={cn(mono, 'text-fg-2')}>{p.replace(/\n$/, '')}</pre>
        : p.trim() ? <p key={i} className="whitespace-pre-wrap break-words leading-relaxed">{p.trim()}</p> : null)}
    </div>
  );
}

function Collapsible({ icon, title, meta, children, defaultOpen = false, bad }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean; bad?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('rounded-lg border', bad ? 'border-fg-3' : 'border-line-strong')}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-raised">
        <ChevronRight className={cn('size-3.5 shrink-0 text-fg-3 transition-transform duration-150', open && 'rotate-90')} />
        <span className="shrink-0 text-fg-3 [&_svg]:size-3.5">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta ? <span className="shrink-0 text-xs text-fg-3">{meta}</span> : null}
      </button>
      {open ? <div className="space-y-2 border-t px-2.5 py-2">{children}</div> : null}
    </div>
  );
}

function ApprovalCard({ agentId, event, pending, resolved }: { agentId: string; event: Ev<'approval_request'>; pending: boolean; resolved?: Ev<'approval_resolved'> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(decision);
    try {
      await api(`/api/agents/${agentId}/approvals/${encodeURIComponent(event.approvalId)}`, { body: { decision, reason: reason.trim() || undefined } });
    } catch (e) {
      toast.error('Could not send the decision', { description: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const summary = toolSummary(event.input);
  return (
    <div className={cn('rounded-lg border p-3', pending ? 'border-fg-2 bg-raised' : 'border-line-strong')}>
      <div className="flex items-center gap-2 text-sm">
        <ShieldQuestion className="size-4 shrink-0" strokeWidth={1.6} />
        <span className="font-medium">{pending ? 'Approval needed' : 'Approval request'}</span>
        <span className="font-mono text-xs text-fg-3">{event.tool}</span>
        {resolved ? <span className="ml-auto flex items-center gap-1 text-xs text-fg-2">{resolved.decision === 'allow' ? <Check className="size-3" /> : <X className="size-3" />}{resolved.decision === 'allow' ? 'Allowed' : 'Denied'}</span>
          : !pending ? <span className="ml-auto text-xs text-fg-3">No longer pending</span> : null}
      </div>
      <pre className={cn(mono, 'mt-2 max-h-60 overflow-y-auto text-fg-2')}>{summary || pretty(event.input)}</pre>
      {summary && Object.keys((event.input ?? {}) as object).length > 1 ? (
        <details className="mt-1.5 text-xs text-fg-3"><summary className="cursor-default select-none hover:text-fg-2">Full input</summary><pre className={cn(mono, 'mt-1.5 max-h-60 overflow-y-auto')}>{pretty(event.input)}</pre></details>
      ) : null}
      {resolved?.reason ? <p className="mt-2 text-xs text-fg-3">Reason: {resolved.reason}</p> : null}
      {pending && !resolved ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, shown to the agent on deny)" aria-label="Reason" className="h-7 min-w-40 flex-1 text-sm" maxLength={1000} />
          <Button size="sm" variant="danger" loading={busy === 'deny'} disabled={!!busy} onClick={() => decide('deny')}><X />Deny</Button>
          <Button size="sm" variant="primary" loading={busy === 'allow'} disabled={!!busy} onClick={() => decide('allow')}><Check />Allow</Button>
        </div>
      ) : null}
    </div>
  );
}

function Separator({ children, ts }: { children: ReactNode; ts: number }) {
  return (
    <div className="flex items-center gap-3 py-0.5 text-2xs uppercase tracking-[0.14em] text-fg-3" role="note">
      <span className="h-px flex-1 bg-line" />
      <span>{children}</span>
      <span className="tnum font-mono normal-case tracking-normal text-fg-4">{time(ts)}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function ItemView({ item, agentId, pendingIds, resolved }: { item: Item; agentId: string; pendingIds: Set<string>; resolved: Map<string, Ev<'approval_resolved'>> }) {
  if (item.kind === 'output')
    return <pre className={cn(mono, item.stream === 'stderr' ? 'border-line-strong text-fg-3' : 'text-fg-2')} aria-label={item.stream}>{item.stream === 'stderr' ? <span className="mb-1 block text-2xs uppercase tracking-wider text-fg-4">stderr</span> : null}{item.text.replace(/\n$/, '')}</pre>;
  if (item.kind === 'tool') {
    const { use, result } = item;
    const summary = toolSummary(use.input);
    return (
      <Collapsible bad={result?.isError} icon={summary && typeof (use.input as { command?: unknown })?.command === 'string' ? <TerminalSquare /> : <Wrench />}
        title={<><span className="font-mono text-xs text-fg-2">{use.name}</span>{summary ? <span className="ml-2 font-mono text-xs text-fg-3">{summary}</span> : null}</>}
        meta={!result ? 'running…' : result.isError ? 'failed' : 'done'}>
        <pre className={cn(mono, 'max-h-72 overflow-y-auto text-fg-2')}>{pretty(use.input)}</pre>
        {result ? <pre className={cn(mono, 'max-h-96 overflow-y-auto', result.isError ? 'border-fg-3 text-fg' : 'text-fg-3')}>{result.output || '(no output)'}</pre> : <p className="text-xs text-fg-3">No result yet.</p>}
      </Collapsible>
    );
  }
  if (item.kind === 'orphan_result')
    return <pre className={cn(mono, 'max-h-96 overflow-y-auto', item.result.isError ? 'border-fg-3 text-fg' : 'text-fg-3')}>{item.result.output || '(no output)'}</pre>;

  const ev = item.event;
  switch (ev.type) {
    case 'user':
      return (
        <div className="ml-auto max-w-[85%] rounded-lg border border-line-strong bg-raised px-3 py-2">
          <div className="mb-1 text-2xs uppercase tracking-[0.14em] text-fg-3">You</div>
          <p className="whitespace-pre-wrap break-words leading-relaxed">{ev.text}</p>
        </div>
      );
    case 'text': return <RichText text={ev.text} />;
    case 'thinking':
      return <Collapsible icon={<span className="font-mono text-2xs">···</span>} title={<span className="text-fg-3">Thinking</span>}><p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-3">{ev.text}</p></Collapsible>;
    case 'status': return <Separator ts={item.ts}>{statusLabel(ev.status)}{ev.detail ? ` — ${ev.detail}` : ''}</Separator>;
    case 'file_change': return <p className="font-mono text-xs text-fg-3"><span className="text-fg-2">{ev.kind}</span> {ev.path}</p>;
    case 'approval_request': return <ApprovalCard agentId={agentId} event={ev} pending={pendingIds.has(ev.approvalId)} resolved={resolved.get(ev.approvalId)} />;
    case 'approval_resolved': return null; // shown on the request card
    case 'usage':
      return <p className="tnum font-mono text-xs text-fg-3">{ev.inputTokens.toLocaleString()} in · {ev.outputTokens.toLocaleString()} out{ev.costUsd != null ? ` · ${usd(ev.costUsd)}` : ''}</p>;
    case 'result':
      return (
        <div className={cn('rounded-lg border p-3', ev.ok ? 'border-line-strong' : 'border-fg-3')}>
          <div className="flex items-center gap-2 text-sm font-medium">{ev.ok ? <Check className="size-4" /> : <X className="size-4" />}{ev.ok ? 'Run finished' : 'Run ended'}<span className="ml-auto font-mono text-xs font-normal text-fg-3">{duration(ev.durationMs / 1000)}</span></div>
          {ev.summary ? <div className="mt-2 text-sm text-fg-2"><RichText text={ev.summary} /></div> : null}
        </div>
      );
    case 'error':
      return <div role="alert" className="rounded-lg border border-fg-3 px-3 py-2"><div className="text-2xs uppercase tracking-[0.14em] text-fg-3">Error</div><p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-xs">{ev.message}</p></div>;
  }
}

export function Stream({ agentId, events, approvals, footer }: { agentId: string; events: AgentEnvelope[]; approvals: Approval[]; footer?: ReactNode }) {
  const items = useMemo(() => buildItems(events), [events]);
  const resolved = useMemo(() => {
    const m = new Map<string, Ev<'approval_resolved'>>();
    for (const { event } of events) if (event.type === 'approval_resolved') m.set(event.approvalId, event);
    return m;
  }, [events]);
  const pendingIds = useMemo(() => new Set(approvals.map((a) => a.approvalId)), [approvals]);

  // Stick to the bottom until the user scrolls up; offer a way back.
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const toBottom = () => { const el = box.current; if (el) el.scrollTop = el.scrollHeight; };
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [items]);
  useEffect(() => {
    // Re-pin when the pane is resized (split view, panel toggles) while following.
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={box} role="log" aria-label="Agent output" tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            setAway(!stick.current);
          }}
          className="h-full space-y-3 overflow-y-auto px-4 py-3 focus:outline-none">
          {items.map((it) => <ItemView key={it.seq} item={it} agentId={agentId} pendingIds={pendingIds} resolved={resolved} />)}
        </div>
        {away ? (
          <button onClick={() => { stick.current = true; setAway(false); toBottom(); }}
            className="absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3 text-xs text-fg-2 shadow-lg transition-colors hover:text-fg">
            <ArrowDown className="size-3" />Jump to latest
          </button>
        ) : null}
      </div>
      {footer}
    </div>
  );
}
