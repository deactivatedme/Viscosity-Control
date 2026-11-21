'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import type { AgentProvider, FsEntry, PermissionMode } from '@viscosity/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { openAgent } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useCredentials, useServers } from '@/lib/queries';
import { openTab } from '@/lib/store';
import type { Agent } from '@/lib/types';

const PROVIDERS: { value: AgentProvider; label: string; blurb: string; cred?: 'anthropic' | 'openai'; model?: string }[] = [
  { value: 'claude', label: 'Claude', blurb: 'Claude Agent SDK (Claude Code). Supports approvals and follow-ups.', cred: 'anthropic', model: 'provider default' },
  { value: 'codex', label: 'Codex', blurb: 'OpenAI Codex SDK. Sandboxed, follow-ups, no interactive approvals.', cred: 'openai', model: 'provider default' },
  { value: 'custom', label: 'Custom', blurb: 'Any agent CLI on the server, run as one supervised process.' },
];

const MODES: { value: PermissionMode; label: string; claude: string; codex: string }[] = [
  { value: 'ask', label: 'Ask', claude: 'Every edit and command waits for your approval in the dashboard.', codex: 'Not available: Codex cannot ask for approvals.' },
  { value: 'acceptEdits', label: 'Accept edits', claude: 'File edits apply automatically; commands and other tools wait for approval.', codex: 'Workspace-write sandbox: edits files in the working directory, no approval prompts.' },
  { value: 'auto', label: 'Auto', claude: 'No approvals. The agent edits files and runs commands on its own.', codex: 'Full access, no sandbox and no approvals.' },
  { value: 'readonly', label: 'Read-only', claude: 'Plan mode: reads and proposes, changes nothing.', codex: 'Read-only sandbox: inspects but cannot modify files.' },
];

export function NewAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const listId = useId();
  const servers = useServers().data ?? [];
  const creds = useCredentials().data ?? [];
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [serverId, setServerId] = useState('');
  const [cwd, setCwd] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<PermissionMode>('ask');
  const [branch, setBranch] = useState('');
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  const server = servers.find((s) => s.id === serverId);
  const root = server?.system?.roots[0];
  // Default to the first online server, then to that server's first allowed root.
  useEffect(() => { if (open && !serverId && servers.length) setServerId((servers.find((s) => s.status === 'online') ?? servers[0]!).id); }, [open, serverId, servers]);
  useEffect(() => { if (root) setCwd(root); }, [root, serverId]);
  useEffect(() => { setCredentialId(''); if (provider !== 'claude' && mode === 'ask') setMode('acceptEdits'); }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirs = useQuery({
    queryKey: ['fs-dirs', serverId, root],
    enabled: open && !!root && server?.status === 'online',
    queryFn: () => api<FsEntry[]>(`/api/servers/${serverId}/fs/list?path=${encodeURIComponent(root!)}`),
    retry: false,
  });

  const p = PROVIDERS.find((x) => x.value === provider)!;
  const usable = creds.filter((c) => c.kind === p.cred);
  const argv = command.split('\n').map((l) => l.trim()).filter(Boolean);

  const create = useMutation({
    mutationFn: () => api<Agent>('/api/agents', {
      body: {
        serverId, provider, cwd: cwd.trim(), prompt, name: name.trim() || undefined,
        // Custom processes run with the worker account's permissions; the mode has no effect on them.
        permissionMode: provider === 'custom' ? 'auto' : mode,
        model: provider !== 'custom' && model.trim() ? model.trim() : undefined,
        credentialId: credentialId || undefined,
        worktreeBranch: branch.trim() || undefined,
        command: provider === 'custom' ? argv : undefined,
      },
    }),
    onSuccess: (agent) => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      openAgent(agent);
      onOpenChange(false);
      setPrompt(''); setName(''); setBranch('');
    },
  });

  const ready = serverId && cwd.trim() && prompt.trim() && (provider !== 'custom' || argv.length > 0);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) create.reset(); onOpenChange(o); }} wide title="New agent"
      description="The agent runs on the server under the worker, and keeps running if you close this dashboard.">
      <form onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate(); }} className="space-y-4">
        <fieldset>
          <legend className="mb-1.5 text-sm text-fg-2">Provider</legend>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {PROVIDERS.map((x) => (
              <button key={x.value} type="button" role="radio" aria-checked={provider === x.value} onClick={() => setProvider(x.value)}
                className={cn('flex flex-col items-start justify-start rounded-lg border p-2.5 text-left transition-colors', provider === x.value ? 'border-fg bg-raised' : 'border-line-strong hover:border-fg-4')}>
                <div className="text-sm font-medium">{x.label}</div>
                <div className="mt-0.5 text-xs leading-snug text-fg-3">{x.blurb}</div>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Field label="Server" error={servers.length === 0 ? 'No servers yet — add one under Servers first.' : null}>
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)} required>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'online' ? '' : s.status === 'pending' ? ' (not enrolled)' : ' (offline)'}</option>)}
              </Select>
            </Field>
            {server && server.status !== 'online' ? <p className="text-xs text-fg-3">This server is not connected. The agent will be queued and start when its worker reconnects.</p> : null}
          </div>
          <Field label="Working directory" hint={root ? `inside ${server?.system?.roots.join(', ')}` : undefined}>
            <Input value={cwd} onChange={(e) => setCwd(e.target.value)} required list={listId} placeholder="/srv/project" className="font-mono text-sm" spellCheck={false} />
            <datalist id={listId}>
              {root ? <option value={root} /> : null}
              {dirs.data?.filter((d) => d.type === 'dir').map((d) => <option key={d.path} value={d.path} />)}
            </datalist>
          </Field>
        </div>

        {provider === 'custom' ? (
          <div className="space-y-1.5">
            <Field label="Command" hint="one argument per line, no shell">
              <Textarea value={command} onChange={(e) => setCommand(e.target.value)} rows={3} required spellCheck={false} placeholder={'aider\n--yes\n--message'} className="font-mono text-sm" />
            </Field>
            <p className="text-xs text-fg-3">The task below is appended as the final argument. The process runs with the worker account&apos;s permissions; permission modes do not apply.</p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Field label="Credential">
                  <Select value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                    <option value="">Use the worker&apos;s own environment</option>
                    {usable.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.hint})</option>)}
                  </Select>
                </Field>
                {usable.length === 0 ? (
                  <p className="text-xs text-fg-3">
                    No {p.cred === 'anthropic' ? 'Anthropic' : 'OpenAI'} key stored. Without one the agent relies on a login already present on the server.{' '}
                    <button type="button" className="text-fg-2 underline underline-offset-2 hover:text-fg" onClick={() => { onOpenChange(false); openTab({ kind: 'settings' }, 'Settings'); }}>Add one in Settings</button>
                  </p>
                ) : null}
              </div>
              <Field label="Model" hint="optional"><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={p.model} maxLength={100} spellCheck={false} /></Field>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm text-fg-2">Permissions</legend>
              <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
                {MODES.map((m) => {
                  const disabled = m.value === 'ask' && provider !== 'claude';
                  return (
                    <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} disabled={disabled} onClick={() => setMode(m.value)}
                      className={cn('flex flex-col items-start justify-start rounded-lg border p-2.5 text-left transition-colors disabled:opacity-40', mode === m.value ? 'border-fg bg-raised' : 'border-line-strong enabled:hover:border-fg-4')}>
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="mt-0.5 text-xs leading-snug text-fg-3">{m[provider === 'codex' ? 'codex' : 'claude']}</div>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="optional"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="defaults to the start of the task" /></Field>
          <div className="space-y-1.5">
            <Field label="Git worktree branch" hint="optional">
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} pattern="[\w.\/\-]+" maxLength={120} placeholder="e.g. agent/fix-tests" className="font-mono text-sm" spellCheck={false} />
            </Field>
            <p className="text-xs text-fg-3">Runs in an isolated worktree on this branch so parallel agents do not collide. Needs a git repository.</p>
          </div>
        </div>

        <Field label="Task">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} required maxLength={100000} placeholder="Describe what the agent should do." />
        </Field>

        {create.error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(create.error)}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>{server && server.status !== 'online' ? 'Queue agent' : 'Start agent'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
