'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronRight, Globe, Play, Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, SkeletonRows, Status, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { openLink } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, dateTime } from '@/lib/format';
import { useAgents, useBrowsers, useMe, useServers } from '@/lib/queries';
import type { WorkflowItem, WorkflowRun } from '@/lib/types';
import { useTopic } from '@/lib/ws';

const PRESETS = [
  { label: 'Manual only', cron: '' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
  { label: 'Custom…', cron: 'custom' },
];
const describe = (cron: string | null) => (cron ? (PRESETS.find((p) => p.cron === cron)?.label ?? 'Custom schedule') : 'Manual only');

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative h-[18px] w-8 shrink-0 rounded-full border transition-colors disabled:opacity-40', checked ? 'border-fg bg-fg' : 'border-line-strong bg-bg')}>
      <span className={cn('absolute top-[2px] size-3 rounded-full transition-all', checked ? 'left-[15px] bg-bg' : 'left-[2px] bg-fg-3')} />
    </button>
  );
}

function ScheduleFields({ preset, setPreset, cron, setCron, tz, setTz }: { preset: string; setPreset: (v: string) => void; cron: string; setCron: (v: string) => void; tz: string; setTz: (v: string) => void }) {
  return (
    <>
      <Field label="Schedule">
        <Select value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map((p) => <option key={p.label} value={p.cron}>{p.label}</option>)}</Select>
      </Field>
      {preset === 'custom' && (
        <Field label="Cron expression" hint="minute hour day month weekday">
          <Input required value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/30 * * * *" className="font-mono" />
        </Field>
      )}
      {preset !== '' && <Field label="Timezone" hint="IANA name"><Input value={tz} onChange={(e) => setTz(e.target.value)} className="font-mono" /></Field>}
    </>
  );
}

function NewWorkflowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const agents = (useAgents().data ?? []).filter((a) => a.permissionMode !== 'ask');
  const browsers = useBrowsers().data ?? [];
  const [kind, setKind] = useState<'agent' | 'browser'>('agent');
  const [sessionId, setSessionId] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('0 9 * * *');
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const sessions = kind === 'agent' ? agents : browsers;
  const create = useMutation({
    mutationFn: () => api('/api/workflows', { body: { name, from: { kind, sessionId }, schedule: preset === 'custom' ? cron : preset || null, timezone: tz } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workflows'] }); toast(`Workflow "${name}" created`); onOpenChange(false); setName(''); setSessionId(''); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New workflow"
      description="A workflow replays the exact configuration of an agent or browser session that has already run — so what gets scheduled is something you have seen work.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Field label="Type">
            <Select value={kind} onChange={(e) => { setKind(e.target.value as 'agent' | 'browser'); setSessionId(''); }}>
              <option value="agent">Agent</option><option value="browser">Browser session</option>
            </Select>
          </Field>
          <Field label="Based on" hint={sessions.length === 0 ? 'none yet' : undefined}>
            <Select required value={sessionId} onChange={(e) => { setSessionId(e.target.value); if (!name) setName(sessions.find((s) => s.id === e.target.value)?.name ?? ''); }}>
              <option value="" disabled>{sessions.length ? 'Choose a past run…' : `Run ${kind === 'agent' ? 'an agent' : 'a browser session'} first`}</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.status}</option>)}
            </Select>
          </Field>
        </div>
        {kind === 'agent' && <p className="-mt-2 text-xs text-fg-3">Agents that ask for approval are not listed: an unattended run cannot wait for a human.</p>}
        <Field label="Name"><Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <ScheduleFields preset={preset} setPreset={setPreset} cron={cron} setCron={setCron} tz={tz} setTz={setTz} />
        {create.error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(create.error)}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!sessionId || !name.trim()}>Create workflow</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function Runs({ wf }: { wf: WorkflowItem }) {
  const q = useQuery({ queryKey: ['workflow-runs', wf.id], queryFn: () => api<WorkflowRun[]>(`/api/workflows/${wf.id}/runs`), refetchInterval: 5000 });
  if (q.isPending) return <SkeletonRows rows={2} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return <p className="px-4 py-4 text-sm text-fg-3">This workflow has not run yet.</p>;
  return (
    <ul className="divide-y">
      {q.data.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="w-36 shrink-0 text-xs text-fg-3">{dateTime(r.startedAt)}</span>
          <span className="w-20 shrink-0 font-mono text-xs text-fg-3">{r.trigger}</span>
          {r.status === 'started' ? <Status status={r.outcome ?? 'lost'} /> : <span className="text-fg-2">{r.status === 'skipped' ? 'Skipped' : 'Could not start'}</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{r.detail}</span>
          {r.sessionId ? <Button size="sm" variant="ghost" onClick={() => openLink(`${wf.kind}:${r.sessionId}`, wf.name)}>Open run</Button> : null}
        </li>
      ))}
    </ul>
  );
}

export default function Workflows() {
  const qc = useQueryClient();
  const canEdit = useMe().data?.role !== 'viewer';
  const servers = useServers().data ?? [];
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api<WorkflowItem[]>('/api/workflows'), refetchInterval: 15_000 });
  useTopic('workflows', () => void qc.invalidateQueries({ queryKey: ['workflows'] }));
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkflowItem | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['workflows'] });
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => api(`/api/workflows/${v.id}`, { method: 'PATCH', body: { enabled: v.enabled } }), onSuccess: refresh, onError: (e) => toast.error(errMsg(e)) });
  const run = useMutation({
    mutationFn: (wf: WorkflowItem) => api<WorkflowRun>(`/api/workflows/${wf.id}/run`, { method: 'POST' }),
    onSuccess: (r, wf) => {
      void refresh(); void qc.invalidateQueries({ queryKey: ['workflow-runs', wf.id] });
      if (r.status === 'started') toast(`"${wf.name}" started`, { action: r.sessionId ? { label: 'Open', onClick: () => openLink(`${wf.kind}:${r.sessionId}`, wf.name) } : undefined });
      else toast.warning(r.status === 'skipped' ? 'Skipped' : 'Could not start', { description: r.detail ?? undefined });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const add = canEdit ? <Button variant="primary" onClick={() => setCreating(true)}><Plus />New workflow</Button> : null;
  return (
    <View flush title="Workflows" subtitle="Reusable and scheduled agent and browser runs. Schedules are stored durably and survive restarts." actions={add}>
      {q.isPending ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data.length === 0 ? (
          <EmptyState icon={WorkflowIcon} title="No workflows yet" action={add}>
            Turn an agent or browser session you have already run into a repeatable job — nightly test runs, periodic repository checks, scheduled reports.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse">
            <thead><tr><Th className="w-8" /><Th>Workflow</Th><Th className="hidden @xl:table-cell">Server</Th><Th>Schedule</Th><Th className="hidden @3xl:table-cell">Next run</Th><Th>Last run</Th><Th>On</Th><Th /></tr></thead>
            <tbody>
              {q.data.map((wf) => {
                const open = expanded === wf.id;
                const Icon = wf.kind === 'agent' ? Bot : Globe;
                return (
                  <Fragment key={wf.id}>
                    <tr className="transition-colors hover:bg-raised">
                      <Td className="pr-0"><button aria-label={open ? 'Hide runs' : 'Show runs'} aria-expanded={open} onClick={() => setExpanded(open ? null : wf.id)} className="rounded p-1 text-fg-3 hover:bg-active hover:text-fg">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</button></Td>
                      <Td><div className="flex items-center gap-2 font-medium"><Icon className="size-3.5 text-fg-3" strokeWidth={1.6} />{wf.name}</div></Td>
                      <Td className="hidden text-sm text-fg-2 @xl:table-cell">{servers.find((s) => s.id === wf.serverId)?.name ?? '—'}</Td>
                      <Td><div className="text-sm">{describe(wf.schedule)}</div>{wf.schedule ? <div className="font-mono text-xs text-fg-3">{wf.schedule} · {wf.timezone}</div> : null}</Td>
                      <Td className="hidden text-sm text-fg-2 @3xl:table-cell">{wf.enabled && wf.nextRunAt ? dateTime(wf.nextRunAt) : '—'}</Td>
                      <Td>{wf.lastRun ? <div>{wf.lastRun.status === 'started' ? <Status status={wf.lastRun.outcome ?? 'lost'} /> : <span className="text-sm text-fg-2">{wf.lastRun.status}</span>}<div className="text-xs text-fg-3">{ago(wf.lastRun.startedAt)}</div></div> : <span className="text-sm text-fg-4">never</span>}</Td>
                      <Td><Toggle checked={wf.enabled} disabled={!canEdit || !wf.schedule} label={`${wf.enabled ? 'Disable' : 'Enable'} schedule for ${wf.name}`} onChange={(enabled) => toggle.mutate({ id: wf.id, enabled })} /></Td>
                      <Td className="text-right">
                        {canEdit ? (
                          <div className="flex justify-end gap-0.5">
                            <Button size="sm" loading={run.isPending && run.variables?.id === wf.id} onClick={() => run.mutate(wf)}><Play />Run now</Button>
                            <Button size="icon" variant="ghost" aria-label={`Delete ${wf.name}`} onClick={() => setDeleting(wf)}><Trash2 /></Button>
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                    {open ? <tr><td colSpan={8} className="border-b bg-panel p-0"><Runs wf={wf} /></td></tr> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      <NewWorkflowDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog open={!!deleting} onOpenChange={() => setDeleting(null)} title={`Delete "${deleting?.name}"?`} confirmLabel="Delete workflow"
        description="The schedule and its run history are removed. Sessions it already started are kept."
        onConfirm={async () => { await api(`/api/workflows/${deleting!.id}`, { method: 'DELETE' }); await refresh(); }} />
    </View>
  );
}
