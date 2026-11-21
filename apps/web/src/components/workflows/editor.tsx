'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Bot, Globe, Plus, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAgents, useBrowsers } from '@/lib/queries';
import type { WorkflowItem, WorkflowStep } from '@/lib/types';

export const PRESETS = [
  { label: 'Manual only', cron: '' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
  { label: 'Custom…', cron: 'custom' },
];
export const describeSchedule = (cron: string | null) => (cron ? (PRESETS.find((p) => p.cron === cron)?.label ?? 'Custom schedule') : 'Manual only');
export const STEP_ICON = { agent: Bot, browser: Globe, approval: ShieldCheck } as const;

type Kind = WorkflowStep['kind'];
/** One row of the editor. `source` is set for newly added steps; existing steps keep what they captured. */
interface Draft { id: string; name: string; kind: Kind; source?: { kind: 'agent' | 'browser'; sessionId: string }; about: string; dependsOn: string[]; retries: number; timeout: string }

const aboutStep = (s: WorkflowStep) =>
  s.kind === 'approval' ? 'Waits for a person to approve'
    : s.kind === 'agent' ? [s.config.provider, s.config.cwd].filter(Boolean).join(' · ')
    : [s.config.mode === 'agent' ? 'autonomous' : 'scripted', s.config.startUrl].filter(Boolean).join(' · ');
const newId = () => Math.random().toString(36).slice(2, 10);

export function WorkflowEditor({ open, onOpenChange, workflow }: { open: boolean; onOpenChange: (o: boolean) => void; workflow?: WorkflowItem | null }) {
  const qc = useQueryClient();
  const agents = (useAgents().data ?? []).filter((a) => a.permissionMode !== 'ask');
  const browsers = useBrowsers().data ?? [];
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('');
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState('UTC');
  const [steps, setSteps] = useState<Draft[]>([]);
  const [addKind, setAddKind] = useState<Kind>('agent');
  const [addSession, setAddSession] = useState('');

  // (Re)load the form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(workflow?.name ?? '');
    const known = PRESETS.some((p) => p.cron === (workflow?.schedule ?? ''));
    setPreset(workflow ? (known ? (workflow.schedule ?? '') : 'custom') : '');
    setCron(workflow?.schedule ?? '');
    setTz(workflow?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
    setSteps((workflow?.steps ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind, about: aboutStep(s), dependsOn: s.dependsOn, retries: s.retries, timeout: s.timeoutSec ? String(s.timeoutSec) : '' })));
    setAddKind('agent');
    setAddSession('');
  }, [open, workflow]);

  const sessions = addKind === 'agent' ? agents : addKind === 'browser' ? browsers : [];
  const patch = (id: string, change: Partial<Draft>) => setSteps((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));
  // Steps may only depend on steps above them, which keeps the graph acyclic by construction.
  const tidy = (all: Draft[]) => all.map((s, i) => ({ ...s, dependsOn: s.dependsOn.filter((d) => all.slice(0, i).some((e) => e.id === d)) }));
  const move = (i: number, by: -1 | 1) => setSteps((all) => {
    const next = [...all];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    return tidy(next);
  });
  function add() {
    if (addKind === 'approval') return setSteps((all) => [...all, { id: newId(), name: 'Approval', kind: 'approval', about: 'Waits for a person to approve', dependsOn: all.length ? [all.at(-1)!.id] : [], retries: 0, timeout: '' }]);
    const picked = sessions.find((s) => s.id === addSession);
    if (!picked) return;
    setSteps((all) => [...all, { id: newId(), name: picked.name.slice(0, 80), kind: addKind, source: { kind: addKind, sessionId: picked.id }, about: `copies “${picked.name}”`, dependsOn: [], retries: 0, timeout: '' }]);
    setAddSession('');
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, timezone: tz, schedule: preset === 'custom' ? cron : preset || null,
        steps: steps.map((s) => ({
          id: s.id, name: s.name, dependsOn: s.dependsOn, retries: s.kind === 'approval' ? 0 : s.retries,
          timeoutSec: s.kind !== 'approval' && s.timeout ? Number(s.timeout) : undefined,
          from: s.source ?? (s.kind === 'approval' && !workflow?.steps.some((e) => e.id === s.id) ? { approval: true } : undefined),
        })),
      };
      return workflow ? api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body }) : api('/api/workflows', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workflows'] }); toast(`Workflow “${name}” ${workflow ? 'saved' : 'created'}`); onOpenChange(false); },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={workflow ? `Edit ${workflow.name}` : 'New workflow'}
      description="Each step replays an agent or browser session you have already run. Steps without a dependency start together; a step starts once everything it runs after has succeeded.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-3 @xl:grid-cols-2">
          <Field label="Name"><Input required autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly checks" /></Field>
          <Field label="Schedule">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map((p) => <option key={p.label} value={p.cron}>{p.label}</option>)}</Select>
          </Field>
          {preset === 'custom' && <Field label="Cron expression" hint="minute hour day month weekday"><Input required value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/30 * * * *" className="font-mono" /></Field>}
          {preset !== '' && <Field label="Timezone" hint="IANA name"><Input value={tz} onChange={(e) => setTz(e.target.value)} className="font-mono" /></Field>}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm text-fg-2">Steps</legend>
          {steps.length === 0 ? <p className="rounded-lg border border-dashed border-line-strong px-3 py-5 text-center text-sm text-fg-3">No steps yet. Add the first one below.</p> : (
            <ol className="space-y-2">
              {steps.map((s, i) => {
                const Icon = STEP_ICON[s.kind];
                return (
                  <li key={s.id} className="rounded-lg border border-line-strong bg-bg p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-2xs text-fg-3">{i + 1}</span>
                      <Icon className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.6} />
                      <Input required maxLength={80} value={s.name} onChange={(e) => patch(s.id, { name: e.target.value })} aria-label={`Name of step ${i + 1}`} className="h-7" />
                      <Button size="icon" variant="ghost" disabled={i === 0} aria-label={`Move step ${i + 1} up`} onClick={() => move(i, -1)}><ArrowUp /></Button>
                      <Button size="icon" variant="ghost" disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`} onClick={() => move(i + 1, -1)}><ArrowDown /></Button>
                      <Button size="icon" variant="ghost" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((all) => tidy(all.filter((x) => x.id !== s.id)))}><X /></Button>
                    </div>
                    <p className="mt-1.5 truncate pl-7 font-mono text-xs text-fg-3">{s.about}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-7">
                      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Step ${i + 1} runs after`}>
                        <span className="text-xs text-fg-3">{i === 0 ? 'Starts immediately' : 'Runs after'}</span>
                        {steps.slice(0, i).map((d, di) => {
                          const on = s.dependsOn.includes(d.id);
                          return (
                            <button key={d.id} type="button" aria-pressed={on} title={d.name}
                              onClick={() => patch(s.id, { dependsOn: on ? s.dependsOn.filter((x) => x !== d.id) : [...s.dependsOn, d.id] })}
                              className={cn('h-6 max-w-40 truncate rounded border px-1.5 text-xs transition-colors', on ? 'border-fg bg-fg text-bg' : 'border-line-strong text-fg-3 hover:text-fg')}>
                              {di + 1} · {d.name}
                            </button>
                          );
                        })}
                        {i > 0 && s.dependsOn.length === 0 ? <span className="text-xs text-fg-4">(nothing — starts immediately)</span> : null}
                      </div>
                      {s.kind !== 'approval' && (
                        <div className="flex items-center gap-3">
                          <label className="flex items-center gap-1.5 text-xs text-fg-3">Retries
                            <Select value={s.retries} onChange={(e) => patch(s.id, { retries: Number(e.target.value) })} className="h-6 w-14 px-1.5 text-xs">{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
                          </label>
                          <label className="flex items-center gap-1.5 text-xs text-fg-3">Timeout
                            <Input type="number" min={1} max={86400} value={s.timeout} onChange={(e) => patch(s.id, { timeout: e.target.value })} placeholder="none" className="h-6 w-20 px-1.5 text-xs" />s
                          </label>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2">
            <Select value={addKind} onChange={(e) => { setAddKind(e.target.value as Kind); setAddSession(''); }} aria-label="Type of step to add" className="h-7 w-40">
              <option value="agent">Agent run</option><option value="browser">Browser session</option><option value="approval">Approval gate</option>
            </Select>
            {addKind !== 'approval' && (
              <Select value={addSession} onChange={(e) => setAddSession(e.target.value)} aria-label="Past run to copy" className="h-7 min-w-0 flex-1">
                <option value="" disabled>{sessions.length ? 'Choose a past run to copy…' : `Run ${addKind === 'agent' ? 'an agent' : 'a browser session'} first`}</option>
                {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.status}</option>)}
              </Select>
            )}
            <Button size="sm" disabled={addKind !== 'approval' && !addSession} onClick={add}><Plus />Add step</Button>
          </div>
          {addKind === 'agent' && <p className="mt-1.5 text-xs text-fg-3">Agents that ask for per-tool approval are not listed: an unattended run cannot wait on them. Use an approval gate instead.</p>}
        </fieldset>

        {save.error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(save.error)}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim() || steps.length === 0}>{workflow ? 'Save workflow' : 'Create workflow'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
