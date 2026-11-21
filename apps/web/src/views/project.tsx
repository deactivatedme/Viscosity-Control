'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderTree, GitBranch, MoreHorizontal, Play, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Branches, Changes, Commits, Worktrees, keys } from '@/components/projects/panels';
import { splitArgs, type GitBranch as Branch, type Project } from '@/components/projects/types';
import { ErrorState, Segmented, SkeletonRows, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Menu, MenuItem } from '@/components/ui/menu';
import { newTerminal, openAgent, openFiles } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { useMe, useServers } from '@/lib/queries';
import { closeTab, renameTab } from '@/lib/store';
import type { Agent } from '@/lib/types';

type Tab = 'changes' | 'commits' | 'branches' | 'worktrees';
const NEW_BRANCH = '\u0000new';

function RunDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [line, setLine] = useState('');
  let argv: string[] = [];
  let parseError: string | null = null;
  try { argv = splitArgs(line); } catch (e) { parseError = errMsg(e); }
  const run = useMutation({
    mutationFn: () => api<Agent>(`/api/projects/${project.id}/run`, { body: { command: argv, name: line.trim().slice(0, 80) } }),
    onSuccess: (session) => { onOpenChange(false); openAgent(session); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Run a command" description={<>Runs in <span className="font-mono text-fg-2">{project.path}</span> as a supervised session: output streams live, it can be stopped, and it stays in the history.</>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <Field label="Command" hint="no shell" error={parseError}>
          <Input autoFocus value={line} onChange={(e) => setLine(e.target.value)} placeholder="npm test" className="font-mono text-sm" spellCheck={false} />
        </Field>
        <p className="text-xs text-fg-3">
          Words are passed as separate arguments (quotes group them). Pipes, <span className="font-mono">&amp;&amp;</span> and variables are not interpreted — wrap in <span className="font-mono">sh -c &apos;…&apos;</span> if you need a shell.
        </p>
        {argv.length > 0 ? <p className="break-all font-mono text-xs text-fg-2">{argv.map((a) => JSON.stringify(a)).join(' ')}</p> : null}
        {run.error ? <p role="alert" className="break-words rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(run.error)}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={run.isPending} disabled={argv.length === 0 || !!parseError}><Play />Run</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export default function ProjectView({ id }: { id?: string }) {
  const qc = useQueryClient();
  const canEdit = useMe().data?.role !== 'viewer';
  const servers = useServers().data;
  const q = useQuery({ queryKey: ['project', id], enabled: !!id, queryFn: () => api<Project>(`/api/projects/${id}`), refetchInterval: 20_000 });
  const project = q.data;
  const server = servers?.find((s) => s.id === project?.serverId);
  const online = !!project?.serverOnline;
  const isRepo = !!project?.git?.isRepo;
  const branches = useQuery({ queryKey: keys(id ?? '').branches, enabled: online && isRepo, queryFn: () => api<Branch[]>(`/api/projects/${id}/branches`), retry: false });
  const [tab, setTab] = useState<Tab>('changes');
  const [dialog, setDialog] = useState<'run' | 'branch' | 'delete' | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [deleteFiles, setDeleteFiles] = useState(false);
  useEffect(() => { if (project && id) renameTab({ kind: 'project', id }, project.name); }, [project?.name, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['project', id] }), qc.invalidateQueries({ queryKey: ['projects'] })]);
  const checkout = useMutation({
    mutationFn: (v: { ref: string; create?: boolean }) => api(`/api/projects/${id}/checkout`, { body: v }),
    onSuccess: (_r, v) => { toast(`${v.create ? 'Created and switched to' : 'Switched to'} ${v.ref}`); setDialog(null); setNewBranch(''); void refresh(); },
    onError: (e) => toast.error('Could not switch branch', { description: errMsg(e) }),
  });
  const pull = useMutation({
    mutationFn: () => api(`/api/projects/${id}/pull`, { method: 'POST' }),
    onSuccess: () => { toast('Pulled the latest changes'); void refresh(); },
    onError: (e) => toast.error('Pull failed', { description: errMsg(e) }),
  });

  if (q.isPending) return <SkeletonRows rows={8} />;
  if (q.error || !project) return <ErrorState error={q.error ?? new Error('project not found')} onRetry={() => q.refetch()} />;
  const current = project.git?.branch ?? null;
  const locals = (branches.data ?? []).filter((b) => !b.remote);

  return (
    <View flush title={project.name}
      subtitle={<span className="font-mono">{[project.repoFullName, server?.name, project.path].filter(Boolean).join(' · ')}</span>}
      actions={<>
        {online && isRepo ? (
          <div className="flex items-center gap-1.5">
            <GitBranch className="size-3.5 text-fg-3" aria-hidden />
            <Select aria-label="Current branch" className="h-8 w-44 font-mono text-sm" disabled={!canEdit || checkout.isPending} value={current ?? ''}
              onChange={(e) => (e.target.value === NEW_BRANCH ? setDialog('branch') : checkout.mutate({ ref: e.target.value }))}>
              {current && !locals.some((b) => b.name === current) ? <option value={current}>{current}</option> : null}
              {!current ? <option value="" disabled>detached HEAD</option> : null}
              {locals.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
              <option value={NEW_BRANCH}>New branch…</option>
            </Select>
          </div>
        ) : null}
        {canEdit && isRepo ? <Button disabled={!online} loading={pull.isPending} onClick={() => pull.mutate()}><Download />Pull</Button> : null}
        <Button disabled={!online} onClick={() => openFiles(project.serverId, project.path)}><FolderTree />Files</Button>
        <Button disabled={!online || !server} onClick={() => server && newTerminal(server, project.path)}><SquareTerminal />Terminal</Button>
        {canEdit ? <Button variant="primary" disabled={!online} onClick={() => setDialog('run')}><Play />Run…</Button> : null}
        {canEdit ? (
          <Menu trigger={<Button variant="ghost" size="icon" aria-label="Project actions"><MoreHorizontal /></Button>}>
            <MenuItem icon={Trash2} danger onSelect={() => { setDeleteFiles(false); setDialog('delete'); }}>Delete project…</MenuItem>
          </Menu>
        ) : null}
      </>}>
      <div className="flex h-full flex-col">
        {!online && <div role="status" className="border-b bg-raised px-4 py-2.5 text-sm text-fg-2">{server?.name ?? 'The server'} is offline. The working tree cannot be read or changed until its worker reconnects.</div>}
        {online && !project.git && <div role="status" className="border-b bg-raised px-4 py-2.5 text-sm text-fg-2">The directory could not be read — it may have been moved or deleted on the server.</div>}
        <div className="flex shrink-0 items-center border-b px-3 py-2">
          <Segmented<Tab> value={tab} onChange={setTab} options={[{ value: 'changes', label: project.git?.changed ? `Changes · ${project.git.changed}` : 'Changes' }, { value: 'commits', label: 'Commits' }, { value: 'branches', label: 'Branches' }, { value: 'worktrees', label: 'Worktrees' }]} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'changes' ? <Changes project={project} canEdit={canEdit} />
            : tab === 'commits' ? <Commits project={project} />
            : tab === 'branches' ? <Branches project={project} canEdit={canEdit} busy={checkout.isPending} onCheckout={(ref) => checkout.mutate({ ref })} />
            : <Worktrees project={project} server={server} canEdit={canEdit} />}
        </div>
      </div>

      <RunDialog project={project} open={dialog === 'run'} onOpenChange={(o) => setDialog(o ? 'run' : null)} />
      <Dialog open={dialog === 'branch'} onOpenChange={(o) => setDialog(o ? 'branch' : null)} title="New branch" description={<>Created from <span className="font-mono text-fg-2">{current ?? 'the current commit'}</span> and checked out. Uncommitted changes come along.</>}>
        <form onSubmit={(e) => { e.preventDefault(); checkout.mutate({ ref: newBranch.trim(), create: true }); }}>
          <Field label="Branch name"><Input autoFocus required value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="feature/my-change" pattern="[\w./@\-]+" className="font-mono text-sm" spellCheck={false} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={checkout.isPending} disabled={!newBranch.trim()}>Create branch</Button>
          </DialogFooter>
        </form>
      </Dialog>
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={(o) => setDialog(o ? 'delete' : null)} title={`Delete ${project.name}?`}
        confirmLabel={deleteFiles ? 'Delete project and files' : 'Delete project'} typeToConfirm={deleteFiles ? project.name : undefined}
        description={<>
          <span className="block">Removes the project from the dashboard. Sessions that ran in it stay in the history.</span>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-fg-2">
            <input type="checkbox" className="mt-0.5 accent-white" checked={deleteFiles} disabled={!online} onChange={(e) => setDeleteFiles(e.target.checked)} />
            <span>Also delete <span className="break-all font-mono text-xs">{project.path}</span> on {server?.name ?? 'the server'}{online ? '. This cannot be undone.' : ' (unavailable while the server is offline).'}</span>
          </label>
        </>}
        onConfirm={async () => {
          await api(`/api/projects/${project.id}`, { method: 'DELETE', body: { deleteFiles } });
          await qc.invalidateQueries({ queryKey: ['projects'] });
          toast(`${project.name} deleted`);
          closeTab({ kind: 'project', id: project.id });
        }} />
    </View>
  );
}
