'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, ChevronDown, ChevronRight, SquareArrowOutUpRight, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, SkeletonRows, StatusDot } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { openLink } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateTime, duration } from '@/lib/format';
import type { WorkflowItem, WorkflowRun, WorkflowStep, WorkflowStepState } from '@/lib/types';
import { STEP_ICON } from './editor';

/** Workflow statuses expressed in the shared monochrome status language. */
const LOOK: Record<string, { dot: string; label: string }> = {
  pending: { dot: 'queued', label: 'Pending' }, running: { dot: 'running', label: 'Running' }, waiting_approval: { dot: 'waiting_approval', label: 'Needs approval' },
  succeeded: { dot: 'completed', label: 'Succeeded' }, failed: { dot: 'failed', label: 'Failed' }, skipped: { dot: 'stopped', label: 'Skipped' },
  cancelled: { dot: 'stopped', label: 'Cancelled' }, started: { dot: 'completed', label: 'Started' },
};
export function RunStatus({ status, className }: { status: string; className?: string }) {
  const look = LOOK[status] ?? { dot: 'stopped', label: status };
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-fg-2', className)}><StatusDot status={look.dot} />{look.label}</span>;
}
export const isLive = (r: Pick<WorkflowRun, 'status'> | null | undefined) => r?.status === 'running' || r?.status === 'waiting_approval';

/** Steps grouped by dependency depth: everything in one group can run at the same time. */
function levels(def: WorkflowStep[]): WorkflowStep[][] {
  const depth = new Map<string, number>();
  // the server only stores acyclic definitions, so this recursion terminates
  const of = (s: WorkflowStep): number => {
    if (!depth.has(s.id)) depth.set(s.id, Math.max(-1, ...s.dependsOn.flatMap((d) => def.filter((x) => x.id === d).map(of))) + 1);
    return depth.get(s.id)!;
  };
  const out: WorkflowStep[][] = [];
  for (const s of def) (out[of(s)] ??= []).push(s);
  return out;
}

function StepCard({ run, step, st, canAct }: { run: WorkflowRun; step: WorkflowStep; st: WorkflowStepState; canAct: boolean }) {
  const qc = useQueryClient();
  const Icon = STEP_ICON[step.kind];
  const session = st.sessionIds.at(-1);
  const decide = useMutation({
    mutationFn: (decision: 'allow' | 'deny') => api(`/api/workflows/runs/${run.id}/approvals/${encodeURIComponent(step.id)}`, { body: { decision } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workflow-runs', run.workflowId] }); void qc.invalidateQueries({ queryKey: ['approvals'] }); },
    onError: (e) => toast.error('Could not record the decision', { description: errMsg(e) }),
  });
  const waiting = st.status === 'waiting_approval';
  return (
    <div className={cn('min-w-44 flex-1 basis-44 rounded-lg border bg-bg p-3', waiting ? 'border-fg-3' : 'border-line-strong')}>
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.6} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={step.name}>{step.name}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <RunStatus status={st.status} className="text-xs" />
        {step.kind !== 'approval' && (st.attempts > 1 || step.retries > 0) ? <span className="font-mono text-2xs text-fg-3">attempt {Math.max(st.attempts, 1)} of {step.retries + 1}</span> : null}
        {st.startedAt && st.finishedAt ? <span className="font-mono text-2xs text-fg-3">{duration((new Date(st.finishedAt).getTime() - new Date(st.startedAt).getTime()) / 1000)}</span> : null}
      </div>
      {st.result ? <p className="mt-1.5 line-clamp-3 break-words text-xs text-fg-3" title={st.result}>{st.result}</p> : null}
      {(waiting && canAct) || session ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {waiting && canAct && <Button size="sm" variant="primary" loading={decide.isPending && decide.variables === 'allow'} disabled={decide.isPending} onClick={() => decide.mutate('allow')}><Check />Approve</Button>}
          {waiting && canAct && <Button size="sm" loading={decide.isPending && decide.variables === 'deny'} disabled={decide.isPending} onClick={() => decide.mutate('deny')}><X />Deny</Button>}
          {session && step.kind !== 'approval' ? <Button size="sm" variant="ghost" onClick={() => openLink(`${step.kind}:${session}`, step.name)}><SquareArrowOutUpRight />Open run</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

function RunRow({ wf, run, canAct, initiallyOpen }: { wf: WorkflowItem; run: WorkflowRun; canAct: boolean; initiallyOpen: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(initiallyOpen);
  const [cancelling, setCancelling] = useState(false);
  const state = run.state;
  const done = state ? Object.values(state.steps).filter((s) => s.status === 'succeeded').length : 0;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <button aria-expanded={open} aria-label={open ? 'Hide steps' : 'Show steps'} disabled={!state} onClick={() => setOpen(!open)} className="rounded p-1 text-fg-3 hover:bg-active hover:text-fg disabled:opacity-30">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="w-36 shrink-0 text-xs text-fg-3">{dateTime(run.startedAt)}</span>
        <span className="w-16 shrink-0 font-mono text-xs text-fg-3">{run.trigger}</span>
        <RunStatus status={run.status} />
        {state ? <span className="font-mono text-xs text-fg-3">{done}/{state.def.length} steps · {duration((end - new Date(run.startedAt).getTime()) / 1000)}</span> : null}
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3" title={run.detail ?? undefined}>{run.detail}</span>
        {!state && run.sessionId ? <Button size="sm" variant="ghost" onClick={() => openLink(`${wf.kind}:${run.sessionId}`, wf.name)}>Open run</Button> : null}
        {isLive(run) && canAct ? <Button size="sm" onClick={() => setCancelling(true)}><Ban />Cancel</Button> : null}
      </div>
      {open && state ? (
        <ol className="space-y-2 px-4 pb-3 pl-12" aria-label="Steps by stage">
          {levels(state.def).map((group, i) => (
            <li key={i} className="flex flex-wrap items-stretch gap-2">
              <span className="flex w-5 shrink-0 items-start justify-center pt-3 font-mono text-2xs text-fg-4" aria-hidden>{i + 1}</span>
              {group.map((step) => <StepCard key={step.id} run={run} step={step} st={state.steps[step.id] ?? { status: 'pending', attempts: 0, sessionIds: [] }} canAct={canAct} />)}
            </li>
          ))}
        </ol>
      ) : null}
      <ConfirmDialog open={cancelling} onOpenChange={setCancelling} title="Cancel this run?" confirmLabel="Cancel run"
        description="Sessions that are still running are stopped, pending approvals are withdrawn, and steps that have not started will not run."
        onConfirm={async () => { await api(`/api/workflows/runs/${run.id}/cancel`, { method: 'POST' }); await qc.invalidateQueries({ queryKey: ['workflow-runs', wf.id] }); await qc.invalidateQueries({ queryKey: ['workflows'] }); }} />
    </li>
  );
}

export function Runs({ wf, canAct }: { wf: WorkflowItem; canAct: boolean }) {
  // Kept fresh by the `workflows` topic (see the view); the interval only keeps durations ticking while something is live.
  const q = useQuery({ queryKey: ['workflow-runs', wf.id], queryFn: () => api<WorkflowRun[]>(`/api/workflows/${wf.id}/runs`), refetchInterval: (query) => (query.state.data?.some(isLive) ? 3000 : false) });
  if (q.isPending) return <SkeletonRows rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return <p className="px-4 py-4 text-sm text-fg-3">This workflow has not run yet.</p>;
  return <ul className="divide-y">{q.data.map((r, i) => <RunRow key={r.id} wf={wf} run={r} canAct={canAct} initiallyOpen={i === 0} />)}</ul>;
}
