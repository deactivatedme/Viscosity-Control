'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Lock, Play, Radio, Square, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Timeline } from '@/components/browser/timeline';
import { EmptyState, ErrorState, SkeletonRows, Status, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { api, errMsg } from '@/lib/api';
import { useMe, useServers } from '@/lib/queries';
import { renameTab, useUi } from '@/lib/store';
import type { BrowserEnvelope, BrowserSession } from '@/lib/types';
import { useConnection, useTopic } from '@/lib/ws';

const ACTIVE = ['queued', 'starting', 'running', 'waiting_approval'];

/**
 * Event history from REST merged with live envelopes, de-duplicated by seq.
 * Every socket (re)connect refetches everything after the last seq we hold, so a
 * refresh or a dropped connection never loses or duplicates timeline entries.
 */
function useBrowserEvents(id: string, onHint: () => void) {
  const [events, setEvents] = useState<BrowserEnvelope[]>([]);
  const last = useRef(0);
  const onHintRef = useRef(onHint);
  onHintRef.current = onHint;
  const epoch = useConnection((s) => s.epoch);
  const merge = (incoming: BrowserEnvelope[]) => setEvents((prev) => {
    const seen = new Set(prev.map((e) => e.seq));
    const fresh = incoming.filter((e) => !seen.has(e.seq));
    if (!fresh.length) return prev;
    const next = [...prev, ...fresh].sort((a, b) => a.seq - b.seq);
    last.current = next.at(-1)!.seq;
    return next;
  });
  useEffect(() => { setEvents([]); last.current = 0; }, [id]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (;;) {
        const page = await api<BrowserEnvelope[]>(`/api/browser/${id}/events?after=${last.current}`);
        if (cancelled) return;
        merge(page);
        // The session row may have been fetched before these events landed; make it catch up.
        if (page.some((e) => e.event.type === 'status')) onHintRef.current();
        if (page.length < 2000) return;
      }
    })().catch((e) => { if (!cancelled) toast.error('Could not load the session timeline', { description: errMsg(e) }); });
    return () => { cancelled = true; };
  }, [id, epoch]);
  useTopic<BrowserEnvelope | { status: string }>(`browser:${id}`, (msg) => {
    if ('seq' in msg) {
      merge([msg]);
      if (msg.event.type === 'status' || msg.event.type.startsWith('approval') || msg.event.type === 'result') onHint();
    } else onHint(); // out-of-band state change (e.g. marked lost after a worker restart)
  });
  return events;
}

export default function BrowserSessionView({ id }: { id?: string }) {
  if (!id) return <EmptyState icon={Globe} title="No session selected">Open a session from Browser Sessions.</EmptyState>;
  return <Session id={id} />;
}

function Session({ id }: { id: string }) {
  const qc = useQueryClient();
  const canRun = useMe().data?.role !== 'viewer';
  const session = useQuery({ queryKey: ['browser', id], queryFn: () => api<BrowserSession>(`/api/browser/${id}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['browser', id] }); };
  const events = useBrowserEvents(id, refresh);
  useTopic('approvals', refresh);
  const servers = useServers().data;
  const [pinned, setPinned] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const s = session.data;
  useEffect(() => { useUi.getState().select({ kind: 'browser', id }); }, [id]);
  useEffect(() => { if (s?.name) renameTab({ kind: 'browser', id }, s.name); }, [id, s?.name]);

  if (session.isPending) return <SkeletonRows />;
  if (session.error || !s) return <ErrorState error={session.error ?? new Error('session not found')} onRetry={() => session.refetch()} />;

  const active = ACTIVE.includes(s.status);
  const shots = events.filter((e) => e.event.type === 'screenshot');
  const liveSeq = shots.at(-1)?.seq ?? s.lastScreenshotSeq;
  const shownSeq = pinned ?? liveSeq;
  const shownUrl = (pinned ? shots.find((e) => e.seq === pinned)?.event : undefined) as { url?: string } | undefined;
  const url = shownUrl?.url ?? s.currentUrl ?? s.startUrl ?? '';
  const server = servers?.find((x) => x.id === s.serverId);
  const pendingIds = new Set((s.approvals ?? []).map((a) => a.approvalId));

  const decide = async (approvalId: string, decision: 'allow' | 'deny') => {
    try {
      await api(`/api/browser/${id}/approvals/${encodeURIComponent(approvalId)}`, { body: { decision } });
      refresh();
    } catch (e) { toast.error(`Could not ${decision} the request`, { description: errMsg(e) }); }
  };
  const restart = async () => {
    setRestarting(true);
    try { await api(`/api/browser/${id}/restart`, { method: 'POST' }); setPinned(null); refresh(); }
    catch (e) { toast.error('Could not run the session again', { description: errMsg(e) }); }
    finally { setRestarting(false); }
  };

  return (
    <View flush title={s.name}
      subtitle={<span className="flex items-center gap-2"><Status status={s.status} className="text-xs" /><span>· {s.mode === 'agent' ? 'Autonomous' : 'Scripted'} on {server?.name ?? 'unknown server'}</span></span>}
      actions={canRun ? (active
        ? <Button onClick={() => setConfirmStop(true)}><Square />Stop</Button>
        : <Button loading={restarting} onClick={restart}><Play />Run again</Button>) : null}>
      <div className="@container flex h-full flex-col">
        {!s.serverOnline && (
          <div role="status" className="flex items-center gap-2 border-b bg-raised px-4 py-2 text-sm text-fg-2">
            <WifiOff className="size-4 shrink-0" strokeWidth={1.6} />
            {active ? 'The server is offline. What you see is the last reported state; the session cannot be observed or stopped until the worker reconnects.' : 'The server is offline. History is still available; running again will queue until it reconnects.'}
          </div>
        )}
        {s.statusDetail ? <p className="border-b px-4 py-2 text-sm text-fg-2">{s.statusDetail}</p> : null}
        {s.mode === 'agent' && s.task ? <p className="line-clamp-3 border-b px-4 py-2 text-sm text-fg-3"><span className="text-fg-2">Task:</span> {s.task}</p> : null}

        <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
          <section aria-label="Browser view" className="flex min-h-64 min-w-0 flex-1 flex-col p-3 @4xl:min-h-0">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line-strong bg-panel">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
                <span className="flex gap-1" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="size-2 rounded-full border border-line-strong" />)}</span>
                <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line-strong bg-bg px-2">
                  <Lock className="size-3 shrink-0 text-fg-4" />
                  <span className="truncate font-mono text-xs text-fg-2" title={url}>{url || 'about:blank'}</span>
                </div>
                {pinned ? <Button size="sm" onClick={() => setPinned(null)}><Radio />Live</Button>
                  : <span className="flex items-center gap-1.5 px-1 font-mono text-2xs uppercase tracking-wider text-fg-3">{active ? <><span className="size-1.5 animate-pulse rounded-full bg-fg" />live</> : 'last frame'}</span>}
              </div>
              <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-bg">
                {shownSeq ? (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin API image
                  <img key={shownSeq} src={`/api/browser/${id}/screenshots/${shownSeq}`} alt={`Browser screenshot at ${url}`} className="max-h-full max-w-full animate-in object-contain" />
                ) : (
                  <div className="self-center"><EmptyState icon={Globe} title={active ? 'Waiting for the first frame' : 'No screenshot was captured'}>
                    {active ? 'A screenshot appears after the first action that changes the page.' : 'This session ended before the browser reported a frame. The timeline shows what happened.'}
                  </EmptyState></div>
                )}
              </div>
            </div>
          </section>
          <section aria-label="Timeline" className="flex min-h-72 flex-col border-t @4xl:min-h-0 @4xl:w-[400px] @4xl:shrink-0 @4xl:border-l @4xl:border-t-0">
            <h2 className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-2xs uppercase tracking-[0.14em] text-fg-3">
              Timeline<span className="tnum font-mono normal-case tracking-normal">{events.length} events</span>
            </h2>
            <div className="min-h-0 flex-1">
              <Timeline events={events} pendingIds={canRun ? pendingIds : new Set()} pinned={pinned} onPin={(seq) => setPinned(seq === liveSeq ? null : seq)} onDecide={decide} />
            </div>
          </section>
        </div>
      </div>
      <ConfirmDialog open={confirmStop} onOpenChange={setConfirmStop} title="Stop this browser session?" confirmLabel="Stop session"
        description="The browser is closed immediately and the task is abandoned mid-way. Anything already submitted on a website stays submitted."
        onConfirm={async () => { await api(`/api/browser/${id}/stop`, { method: 'POST' }); refresh(); }} />
    </View>
  );
}
