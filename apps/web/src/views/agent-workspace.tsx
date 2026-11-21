'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Bot, RotateCcw, SendHorizontal, Square, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SidePanel, type PanelTab } from '@/components/agents/side-panel';
import { Stream } from '@/components/agents/stream';
import { isActive, useAgentSession } from '@/components/agents/use-agent-events';
import { Badge, EmptyState, ErrorState, Segmented, SkeletonRows, Status } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { api, ApiError, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useServers } from '@/lib/queries';
import { renameTab, useUi } from '@/lib/store';
import type { Agent } from '@/lib/types';

type Tab = 'stream' | PanelTab;
const PANEL_TABS: { value: PanelTab; label: string }[] = [{ value: 'changes', label: 'Changes' }, { value: 'commands', label: 'Commands' }, { value: 'files', label: 'Files' }];

/** Why a follow-up cannot be sent, or null when it can. */
function followUpBlocker(a: Agent): string | null {
  if (isActive(a.status)) return null; // composer is simply hidden while it works
  if (a.archivedAt) return 'This agent is archived. Unarchive it to continue.';
  if (!a.capabilities.resume) return `${a.provider === 'custom' ? 'Custom' : a.provider} agents cannot continue a conversation. Use Restart to run the task again.`;
  if (!a.providerSessionId) return 'This run never produced a provider conversation to resume. Use Restart to run the task again.';
  return null;
}

function Composer({ agent, onSent }: { agent: Agent; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/messages`, { body: { prompt: text } });
      setText('');
      onSent();
    } catch (e) {
      toast.error('Could not send the message', { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex shrink-0 items-end gap-2 border-t bg-panel p-3">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="Follow-up message"
        placeholder={agent.serverOnline ? 'Send a follow-up — continues the same conversation (⌘↵ to send)' : 'The server is offline; follow-ups need it online'}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
        className="max-h-48 min-h-14 flex-1" />
      <Button type="submit" variant="primary" loading={busy} disabled={!text.trim()}><SendHorizontal />Send</Button>
    </form>
  );
}

export default function AgentWorkspace({ id }: { id?: string }) {
  if (!id) return <EmptyState icon={Bot} title="No agent selected">Open an agent from the Agents list.</EmptyState>;
  return <Workspace id={id} />;
}

function Workspace({ id }: { id: string }) {
  const qc = useQueryClient();
  const { agent, events, loading, error, retry, refetchAgent } = useAgentSession(id);
  const server = useServers().data?.find((s) => s.id === agent.data?.serverId);
  const [tab, setTab] = useState<Tab>('stream');
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const a = agent.data;

  useEffect(() => { useUi.getState().select({ kind: 'agent', id }); }, [id]);
  useEffect(() => { if (a?.name) renameTab({ kind: 'agent', id }, a.name); }, [a?.name, id]);

  if (agent.isPending) return <SkeletonRows rows={8} />;
  if (agent.error || !a) {
    if (agent.error instanceof ApiError && agent.error.status === 404) return <EmptyState icon={Bot} title="Agent not found">It may have been removed together with its server. Close this tab.</EmptyState>;
    return <ErrorState error={agent.error} onRetry={() => agent.refetch()} />;
  }

  const act = async (name: string, path: string, body?: unknown, done?: string) => {
    setBusy(name);
    try {
      await api(`/api/agents/${id}/${path}`, { method: 'POST', body });
      refetchAgent();
      void qc.invalidateQueries({ queryKey: ['agents'] });
      if (done) toast(done);
    } catch (e) {
      toast.error(`Could not ${name} the agent`, { description: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };

  const active = isActive(a.status);
  const blocker = followUpBlocker(a);
  const panelTab: PanelTab = tab === 'stream' ? 'changes' : tab;

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[15px] font-medium tracking-tight">{a.name}</h1>
            <Badge>{a.provider}</Badge>
            {a.archivedAt ? <Badge>archived</Badge> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-3">
            <Status status={a.status} className="text-xs" />
            <span className="truncate">on {server?.name ?? 'unknown server'}</span>
            <span className="truncate font-mono">{a.worktreePath ?? a.cwd}</span>
          </div>
          {a.statusDetail ? <p className="mt-0.5 line-clamp-2 text-xs text-fg-2">{a.statusDetail}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active
            ? <Button variant="danger" size="sm" loading={busy === 'stop'} onClick={() => setConfirmStop(true)}><Square />{a.status === 'queued' ? 'Cancel' : 'Stop'}</Button>
            : <Button size="sm" loading={busy === 'restart'} disabled={!!a.archivedAt} onClick={() => act('restart', 'restart')}><RotateCcw />Restart</Button>}
          {!active && (a.archivedAt
            ? <Button variant="ghost" size="sm" loading={busy === 'unarchive'} onClick={() => act('unarchive', 'archive', { archived: false }, 'Agent restored')}><ArchiveRestore />Unarchive</Button>
            : <Button variant="ghost" size="sm" loading={busy === 'archive'} onClick={() => act('archive', 'archive', { archived: true }, 'Agent archived')}><Archive />Archive</Button>)}
        </div>
      </header>

      {!a.serverOnline ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b bg-raised px-4 py-1.5 text-xs text-fg-2">
          <WifiOff className="size-3.5 shrink-0" />
          {server?.name ?? 'The server'} is offline — showing the last known state.{active ? ' The agent may still be running on the machine; this view catches up when the worker reconnects.' : ''}
        </div>
      ) : null}

      {/* narrow: one pane at a time */}
      <div className="flex shrink-0 overflow-x-auto border-b px-4 py-1.5 [scrollbar-width:none] @4xl:hidden">
        <Segmented<Tab> value={tab} onChange={setTab} options={[{ value: 'stream', label: 'Conversation' }, ...PANEL_TABS]} />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn('min-h-0 min-w-0 flex-1 flex-col', tab === 'stream' ? 'flex' : 'hidden @4xl:flex')}>
          {loading && events.length === 0 ? <SkeletonRows rows={6} />
            : error && events.length === 0 ? <ErrorState error={error} onRetry={retry} />
            : events.length === 0 ? (
              <EmptyState icon={Bot} title={a.status === 'queued' ? 'Queued' : 'No output yet'}>
                {a.status === 'queued' ? (a.statusDetail ?? 'Waiting to start on the worker.') : 'Events appear here as the worker reports them.'}
              </EmptyState>
            ) : (
              <Stream agentId={id} events={events} approvals={a.approvals ?? []}
                footer={active ? null : blocker
                  ? <p className="shrink-0 border-t bg-panel px-4 py-2.5 text-xs text-fg-3">{blocker}</p>
                  : <Composer agent={a} onSent={refetchAgent} />} />
            )}
          {error && events.length > 0 ? <p role="alert" className="shrink-0 border-t px-4 py-1.5 text-xs text-fg-2">History may be incomplete: {errMsg(error)} <button onClick={retry} className="underline underline-offset-2">Retry</button></p> : null}
        </div>
        <div className={cn('min-h-0 min-w-0 flex-col @4xl:flex @4xl:w-[44%] @4xl:max-w-2xl @4xl:flex-none @4xl:border-l', tab === 'stream' ? 'hidden' : 'flex flex-1')}>
          <div className="hidden h-10 shrink-0 items-center border-b px-3 @4xl:flex">
            <Segmented<PanelTab> value={panelTab} onChange={setTab} options={PANEL_TABS} />
          </div>
          <div className="min-h-0 flex-1"><SidePanel tab={panelTab} agent={a} events={events} /></div>
        </div>
      </div>

      <ConfirmDialog open={confirmStop} onOpenChange={setConfirmStop} title={a.status === 'queued' ? 'Cancel this agent?' : 'Stop this agent?'} confirmLabel={a.status === 'queued' ? 'Cancel agent' : 'Stop agent'}
        description={a.status === 'queued' ? 'It has not started yet and will be removed from the queue.' : 'The run is interrupted on the server. Work already written to disk stays as it is; the status changes once the worker confirms.'}
        onConfirm={() => api(`/api/agents/${id}/stop`, { method: 'POST' }).then(() => { refetchAgent(); void qc.invalidateQueries({ queryKey: ['agents'] }); })} />
    </div>
  );
}
