'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, SkeletonRows, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { describeSchedule, STEP_ICON, WorkflowEditor } from '@/components/workflows/editor';
import { isLive, Runs, RunStatus } from '@/components/workflows/runs';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, dateTime } from '@/lib/format';
import { useMe, useServers } from '@/lib/queries';
import type { WorkflowItem, WorkflowRun } from '@/lib/types';
import { useTopic } from '@/lib/ws';

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-[18px] w-8 shrink-0 rounded-full border transition-colors disabled:opacity-40', checked ? 'border-fg bg-fg' : 'border-line-strong bg-bg')}>
      <span className={cn('absolute top-[2px] size-3 rounded-full transition-all', checked ? 'left-[15px] bg-bg' : 'left-[2px] bg-fg-3')} />
    </button>
  );
}

export default function Workflows() {
  const qc = useQueryClient();
  const canEdit = useMe().data?.role !== 'viewer';
  const servers = useServers().data ?? [];
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowItem[]>('/api/workflows'), refetchInterval: 15_000 });
  // Every engine state change is announced on this topic.
  useTopic<{ id?: string }>('workflows', (e) => {
    void qc.invalidateQueries({ queryKey: ['workflows'] });
    void qc.invalidateQueries({ queryKey: e.id ? ['workflow-runs', e.id] : ['workflow-runs'] });
  });
  const [editing, setEditing] = useState<WorkflowItem | 'new' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkflowItem | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['workflows'] });
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => api(`/api/workflows/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), onSuccess: refresh, onError: (e) => toast.error(errMsg(e)) });
  const run = useMutation({
    mutationFn: (wf: WorkflowItem) => api<WorkflowRun>(`/api/workflows/${wf.id}/run`, { method: 'POST' }),
    onSuccess: (r, wf) => {
      void refresh(); void qc.invalidateQueries({ queryKey: ['workflow-runs', wf.id] });
      if (r.status === 'skipped') return void toast.warning('Not started', { description: r.detail ?? undefined });
      setExpanded(wf.id);
      toast(`“${wf.name}” started`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const add = canEdit ? <Button variant="primary" onClick={() => setEditing('new')}><Plus />New workflow</Button> : null;
  return (
    <View flush title="Workflows" subtitle="Multi-step and scheduled agent and browser runs. Progress is checkpointed, so runs survive restarts." actions={add}>
      {q.isPending ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data.length === 0 ? (
          <EmptyState icon={WorkflowIcon} title="No workflows yet" action={add}>
            Chain agent and browser sessions you have already run into a repeatable job — steps in parallel or in sequence, with retries, timeouts and approval gates, on demand or on a schedule.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse">
            <thead><tr><Th className="w-8" /><Th>Workflow</Th><Th className="hidden @3xl:table-cell">Server</Th><Th>Schedule</Th><Th className="hidden @5xl:table-cell">Next run</Th><Th>Last run</Th><Th>On</Th><Th /></tr></thead>
            <tbody>
              {q.data.map((wf) => {
                const open = expanded === wf.id;
                const hosts = [...new Set(wf.steps.filter((s) => s.kind !== 'approval').map((s) => s.serverId))];
                return (
                  <Fragment key={wf.id}>
                    <tr className="transition-colors hover:bg-raised">
                      <Td className="pr-0"><button aria-label={open ? `Hide runs of ${wf.name}` : `Show runs of ${wf.name}`} aria-expanded={open} onClick={() => setExpanded(open ? null : wf.id)} className="rounded p-1 text-fg-3 hover:bg-active hover:text-fg">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button></Td>
                      <Td>
                        <div className="font-medium">{wf.name}</div>
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-fg-3">
                          {wf.steps.slice(0, 8).map((s) => { const Icon = STEP_ICON[s.kind]; return <Icon key={s.id} className="size-3" strokeWidth={1.6} aria-hidden />; })}
                          <span className="ml-1">{wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}</span>
                        </div>
                      </Td>
                      <Td className="hidden text-sm text-fg-2 @3xl:table-cell">{servers.find((s) => s.id === hosts[0])?.name ?? '—'}{hosts.length > 1 ? ` +${hosts.length - 1}` : ''}</Td>
                      <Td><div className="text-sm">{describeSchedule(wf.schedule)}</div>{wf.schedule ? <div className="font-mono text-xs text-fg-3">{wf.schedule} · {wf.timezone}</div> : null}</Td>
                      <Td className="hidden text-sm text-fg-2 @5xl:table-cell">{wf.enabled && wf.nextRunAt ? dateTime(wf.nextRunAt) : '—'}</Td>
                      <Td>{wf.lastRun ? <div><RunStatus status={wf.lastRun.status} /><div className="text-xs text-fg-3">{ago(wf.lastRun.startedAt)}</div></div> : <span className="text-sm text-fg-4">never</span>}</Td>
                      <Td><Toggle checked={wf.enabled && !!wf.schedule} disabled={!canEdit || !wf.schedule} label={`${wf.enabled ? 'Disable' : 'Enable'} schedule for ${wf.name}`} onChange={(enabled) => toggle.mutate({ id: wf.id, enabled })} /></Td>
                      <Td className="text-right">
                        {canEdit ? (
                          <div className="flex justify-end gap-0.5">
                            <Button size="sm" disabled={isLive(wf.lastRun)} loading={run.isPending && run.variables?.id === wf.id} onClick={() => run.mutate(wf)}><Play />Run now</Button>
                            <Button size="icon" variant="ghost" aria-label={`Edit ${wf.name}`} onClick={() => setEditing(wf)}><Pencil /></Button>
                            <Button size="icon" variant="ghost" aria-label={`Delete ${wf.name}`} onClick={() => setDeleting(wf)}><Trash2 /></Button>
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                    {open ? <tr><td colSpan={8} className="border-b bg-panel p-0"><Runs wf={wf} canAct={canEdit} /></td></tr> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      <WorkflowEditor open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }} workflow={editing === 'new' ? null : editing} />
      <ConfirmDialog open={!!deleting} onOpenChange={() => setDeleting(null)} title={`Delete “${deleting?.name}”?`} confirmLabel="Delete workflow"
        description="The schedule and its run history are removed, and a run in progress is cancelled. Sessions it already started are kept."
        onConfirm={async () => { await api(`/api/workflows/${deleting!.id}`, { method: 'DELETE' }); await refresh(); }} />
    </View>
  );
}
