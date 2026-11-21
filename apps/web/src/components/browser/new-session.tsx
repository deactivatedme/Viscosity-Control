'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BrowserStep } from '@viscosity/protocol';
import { Segmented } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { openBrowser } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { useCredentials, useServers } from '@/lib/queries';
import { openTab } from '@/lib/store';
import type { BrowserSession } from '@/lib/types';

type Action = BrowserStep['action'];
/** Builder rows keep every field as a string; `toSteps` shapes them into protocol steps. */
interface Row { action: Action; a: string; b: string }

const ACTIONS: Record<Action, { label: string; a?: string; b?: string; aPlaceholder?: string; bPlaceholder?: string }> = {
  goto: { label: 'Go to URL', a: 'URL', aPlaceholder: 'https://example.com' },
  click: { label: 'Click', a: 'Selector', aPlaceholder: 'button[type=submit]' },
  fill: { label: 'Fill', a: 'Selector', b: 'Value', aPlaceholder: '#email', bPlaceholder: 'text to type' },
  press: { label: 'Press key', a: 'Key', aPlaceholder: 'Enter' },
  waitFor: { label: 'Wait for', a: 'Selector', aPlaceholder: '.result' },
  extract: { label: 'Extract', a: 'Selector', b: 'Attribute (optional)', aPlaceholder: 'h1', bPlaceholder: 'text content if empty' },
  screenshot: { label: 'Screenshot' },
  approval: { label: 'Ask for approval', a: 'Reason', aPlaceholder: 'Why a human should confirm before continuing' },
};

function toSteps(rows: Row[]): unknown[] {
  return rows.map(({ action, a, b }) => {
    switch (action) {
      case 'goto': return { action, url: a.trim() };
      case 'fill': return { action, selector: a, value: b };
      case 'press': return { action, key: a.trim() };
      case 'extract': return b.trim() ? { action, selector: a, attribute: b.trim() } : { action, selector: a };
      case 'screenshot': return { action };
      case 'approval': return { action, reason: a };
      default: return { action, selector: a };
    }
  });
}
function toRows(steps: BrowserStep[]): Row[] {
  return steps.map((s) => {
    switch (s.action) {
      case 'goto': return { action: s.action, a: s.url, b: '' };
      case 'fill': return { action: s.action, a: s.selector, b: s.value };
      case 'press': return { action: s.action, a: s.key, b: '' };
      case 'extract': return { action: s.action, a: s.selector, b: s.attribute ?? '' };
      case 'screenshot': return { action: s.action, a: '', b: '' };
      case 'approval': return { action: s.action, a: s.reason, b: '' };
      default: return { action: s.action, a: s.selector, b: '' };
    }
  });
}

const Steps = BrowserStep.array().min(1, 'add at least one step').max(200);
/** Validate against the same schema the API and worker use, plus "no empty fields". */
function validate(raw: unknown): { steps?: BrowserStep[]; errors: string[] } {
  const r = Steps.safeParse(raw);
  if (!r.success) return { errors: r.error.issues.map((i) => `${i.path.length ? `step ${Number(i.path[0]) + 1}${i.path[1] ? `.${String(i.path[1])}` : ''}: ` : ''}${i.message}`) };
  const errors: string[] = [];
  r.data.forEach((s, i) => {
    for (const [k, v] of Object.entries(s)) if (k !== 'value' && k !== 'attribute' && typeof v === 'string' && !v.trim()) errors.push(`step ${i + 1}: ${k} is empty`);
  });
  return errors.length ? { errors } : { steps: r.data, errors };
}

function StepBuilder({ rows, onChange }: { rows: Row[]; onChange: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => { const n = [...rows]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; onChange(n); };
  return (
    <div className="space-y-1.5">
      <ol className="space-y-1.5">
        {rows.map((row, i) => {
          const def = ACTIONS[row.action];
          return (
            <li key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-bg p-1.5">
              <span className="tnum w-5 shrink-0 text-center font-mono text-2xs text-fg-3">{i + 1}</span>
              <div className="w-40 shrink-0">{/* Select is w-full; the wrapper sets the width */}
                <Select aria-label={`Step ${i + 1} action`} value={row.action} onChange={(e) => set(i, { action: e.target.value as Action })}>
                  {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              </div>
              {def.a ? <Input aria-label={`Step ${i + 1} ${def.a}`} className="min-w-32 flex-1 font-mono text-xs" placeholder={def.aPlaceholder} value={row.a} onChange={(e) => set(i, { a: e.target.value })} />
                : <span className="min-w-32 flex-1 px-1 text-xs text-fg-3">Captures the page as it is at this point.</span>}
              {def.b ? <Input aria-label={`Step ${i + 1} ${def.b}`} className="min-w-32 flex-1 font-mono text-xs" placeholder={def.bPlaceholder} value={row.b} onChange={(e) => set(i, { b: e.target.value })} /> : null}
              <div className="ml-auto flex shrink-0">
                <Button variant="ghost" size="icon" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                <Button variant="ghost" size="icon" aria-label={`Move step ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                <Button variant="ghost" size="icon" aria-label={`Remove step ${i + 1}`} disabled={rows.length === 1} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            </li>
          );
        })}
      </ol>
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { action: 'click', a: '', b: '' }])}><Plus />Add step</Button>
    </div>
  );
}

export function NewBrowserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const servers = useServers().data ?? [];
  const anthropic = (useCredentials().data ?? []).filter((c) => c.kind === 'anthropic');
  const [serverId, setServerId] = useState('');
  const [mode, setMode] = useState<'steps' | 'agent'>('steps');
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([{ action: 'goto', a: '', b: '' }]);
  const [json, setJson] = useState<string | null>(null); // non-null ⇒ editing raw JSON
  const [task, setTask] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const server = serverId || servers.find((s) => s.status === 'online')?.id || servers[0]?.id || '';
  const cred = credentialId || anthropic[0]?.id || '';

  const parseJson = (): { steps?: BrowserStep[]; errors: string[] } => {
    try { return validate(JSON.parse(json ?? '')); } catch (e) { return { errors: [`not valid JSON: ${errMsg(e)}`] }; }
  };
  const toggleJson = () => {
    if (json === null) return setJson(JSON.stringify(toSteps(rows), null, 2));
    const r = parseJson();
    if (!r.steps) return setErrors(r.errors); // stay in JSON mode until it parses
    setRows(toRows(r.steps)); setJson(null); setErrors([]);
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<BrowserSession>('/api/browser', { body }),
    onSuccess: (s) => { void qc.invalidateQueries({ queryKey: ['browsers'] }); openBrowser(s); close(false); },
  });
  const close = (o: boolean) => { if (!o) { create.reset(); setErrors([]); } onOpenChange(o); };

  const submit = () => {
    setErrors([]);
    if (mode === 'agent') {
      return create.mutate({ serverId: server, mode, name: name.trim() || undefined, task: task.trim(), startUrl: startUrl.trim() || undefined, credentialId: cred, model: model.trim() || undefined });
    }
    const r = json === null ? validate(toSteps(rows)) : parseJson();
    if (!r.steps) return setErrors(r.errors);
    create.mutate({ serverId: server, mode, name: name.trim() || undefined, steps: r.steps });
  };
  const canSubmit = !!server && (mode === 'steps' || (task.trim().length > 0 && !!cred));
  const allErrors = [...errors, ...(create.error ? [errMsg(create.error)] : [])];

  return (
    <Dialog open={open} onOpenChange={close} wide title="New browser session"
      description="Runs in an isolated Chromium on the selected server. Each session gets a fresh profile that is discarded afterwards.">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Server">
            <Select value={server} onChange={(e) => setServerId(e.target.value)} required>
              {servers.length === 0 && <option value="">No servers enrolled</option>}
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'online' ? '' : ` (${s.status} — will queue)`}</option>)}
            </Select>
          </Field>
          <Field label="Name" hint="optional"><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout smoke test" /></Field>
        </div>
        <div className="flex items-center justify-between">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'steps', label: 'Scripted' }, { value: 'agent', label: 'Autonomous' }]} />
          {mode === 'steps' && <button type="button" onClick={toggleJson} className="text-xs text-fg-2 underline underline-offset-4 hover:text-fg">{json === null ? 'Edit as JSON' : 'Back to step builder'}</button>}
        </div>

        {mode === 'steps' ? (
          json === null ? <StepBuilder rows={rows} onChange={setRows} />
            : <Textarea aria-label="Steps as JSON" spellCheck={false} className="min-h-56 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
        ) : (
          <div className="space-y-4">
            <Field label="Task"><Textarea required value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe what the agent should accomplish and what to report back." /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start URL" hint="optional"><Input type="url" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="https://…" /></Field>
              <Field label="Model" hint="optional"><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-opus-5-5" className="font-mono text-xs" /></Field>
            </div>
            {anthropic.length ? (
              <Field label="Anthropic credential">
                <Select value={cred} onChange={(e) => setCredentialId(e.target.value)}>{anthropic.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.hint})</option>)}</Select>
              </Field>
            ) : (
              <p className="rounded-lg border border-line-strong bg-bg p-3 text-sm text-fg-2">
                No Anthropic credential is stored, so an autonomous session cannot run yet.{' '}
                <button type="button" className="text-fg underline underline-offset-4" onClick={() => { close(false); openTab({ kind: 'settings' }, 'Settings'); }}>Add one in Settings → AI providers</button>.
              </p>
            )}
            <p className="flex gap-2 text-xs leading-relaxed text-fg-3">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              The model is instructed to pause for your approval before purchases, payments, publishing, account changes and similar consequential actions. Requests to private-network and cloud-metadata addresses are blocked by the worker.
            </p>
          </div>
        )}

        {allErrors.length ? (
          <ul role="alert" className="space-y-0.5 rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{allErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!canSubmit}>Start session</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
