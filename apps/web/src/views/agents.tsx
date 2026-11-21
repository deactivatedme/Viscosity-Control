'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { isActive } from '@/components/agents/use-agent-events';
import { Badge, EmptyState, ErrorState, Segmented, SkeletonRows, Status, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { openAgent } from '@/lib/actions';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, duration, usd } from '@/lib/format';
import { useAgents, useMe, useServers } from '@/lib/queries';
import { shell, useUi } from '@/lib/store';
import type { Agent } from '@/lib/types';
import { useTopic } from '@/lib/ws';

type Filter = 'active' | 'all' | 'archived';

function runtime(a: Agent, now: number): string {
  if (!a.startedAt) return '—';
  const end = a.endedAt ? new Date(a.endedAt).getTime() : isActive(a.status) ? now : new Date(a.startedAt).getTime();
  return duration((end - new Date(a.startedAt).getTime()) / 1000);
}

export default function Agents() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const live = useAgents();
  const archived = useQuery({ queryKey: ['agents-archived'], enabled: filter === 'archived', queryFn: () => api<Agent[]>('/api/agents?archived=1') });
  useTopic('agents', () => void qc.invalidateQueries({ queryKey: ['agents-archived'] }));
  const servers = useServers().data ?? [];
  const canRun = useMe().data?.role !== 'viewer';
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const intent = useUi((s) => s.intent);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (intent === 'new-agent') { setCreating(true); useUi.getState().setIntent(null); } }, [intent]);

  const q = filter === 'archived' ? archived : live;
  const rows = filter === 'active' ? q.data?.filter((a) => isActive(a.status)) : q.data;
  const running = live.data?.filter((a) => isActive(a.status)).length ?? 0;

  // Tick once a second only while something is running, so durations count up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const add = canRun ? <Button variant="primary" onClick={() => setCreating(true)}><Plus />New agent</Button> : null;
  return (
    <View flush title="Agents" subtitle={live.data ? `${running} running · ${live.data.length} total` : undefined}
      actions={<><Segmented<Filter> value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }, { value: 'archived', label: 'Archived' }]} />{add}</>}>
      {q.isPending ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : !rows || rows.length === 0 ? (
          filter === 'all' ? (
            <EmptyState icon={Bot} title="No agents yet" action={add}>
              Launch a Claude, Codex or custom coding agent on one of your servers. It is supervised by the worker there and streams its real output here.
            </EmptyState>
          ) : filter === 'active' ? (
            <EmptyState icon={Bot} title="Nothing running" action={add}>No agent is queued or working right now. Finished runs are under All.</EmptyState>
          ) : <EmptyState icon={Bot} title="No archived agents">Agents you archive from their workspace are kept here with their full history.</EmptyState>
        ) : (
          <table className="w-full border-collapse text-base">
            <thead><tr><Th>Agent</Th><Th>Status</Th><Th className="hidden @xl:table-cell">Server</Th><Th className="hidden @3xl:table-cell">Started</Th><Th>Duration</Th><Th className="hidden @3xl:table-cell">Cost</Th><Th /></tr></thead>
            <tbody>
              {rows.map((a) => {
                const selected = selection?.kind === 'agent' && selection.id === a.id;
                const server = servers.find((s) => s.id === a.serverId);
                return (
                  <tr key={a.id} tabIndex={0} aria-selected={selected}
                    onClick={() => { select({ kind: 'agent', id: a.id }); shell.showInspector(); }}
                    onDoubleClick={() => openAgent(a)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openAgent(a); }}
                    className={cn('cursor-default transition-colors hover:bg-raised focus-visible:bg-raised', selected && 'bg-raised')}>
                    <Td className="max-w-0 w-[45%]">
                      <div className="flex items-center gap-2"><span className="truncate font-medium">{a.name}</span><Badge className="shrink-0">{a.provider}</Badge></div>
                      <div className="truncate font-mono text-xs text-fg-3">{a.worktreePath ?? a.cwd}</div>
                    </Td>
                    <Td className="whitespace-nowrap"><Status status={a.status} /></Td>
                    <Td className="hidden whitespace-nowrap text-sm text-fg-2 @xl:table-cell">{server?.name ?? '—'}{a.serverOnline ? '' : <span className="text-fg-3"> · offline</span>}</Td>
                    <Td className="hidden whitespace-nowrap text-sm text-fg-2 @3xl:table-cell">{a.startedAt ? ago(a.startedAt) : 'not started'}</Td>
                    <Td className="tnum whitespace-nowrap font-mono text-xs text-fg-2">{runtime(a, now)}</Td>
                    <Td className="tnum hidden whitespace-nowrap font-mono text-xs text-fg-2 @3xl:table-cell">{a.costUsd == null ? <span className="text-fg-4">—</span> : usd(a.costUsd)}</Td>
                    <Td className="text-right">
                      <Button variant="ghost" size="icon" aria-label={`Open ${a.name}`} onClick={(e) => { e.stopPropagation(); openAgent(a); }}><SquareArrowOutUpRight /></Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      <NewAgentDialog open={creating} onOpenChange={setCreating} />
    </View>
  );
}
