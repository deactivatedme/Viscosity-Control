'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDiff, FolderTree, GitBranch as BranchIcon, GitCommitHorizontal, GitPullRequest, RefreshCw, SquareTerminal, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Diff } from '@/components/agents/side-panel';
import { Badge, EmptyState, ErrorState, SkeletonRows, Td, Th } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { newTerminal, openFiles } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import type { Server } from '@/lib/types';
import type { GitBranch, GitCommit, GitStatus, GitWorktree, Project } from './types';

export const keys = (id: string) => ({ all: ['project', id] as const, status: ['project', id, 'status'] as const, branches: ['project', id, 'branches'] as const });
const url = (p: Project, rest: string) => `/api/projects/${p.id}/${rest}`;

function PullRequestDialog({ project, head, branches, open, onOpenChange }: { project: Project; head: string; branches: GitBranch[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const locals = branches.filter((b) => !b.remote && b.name !== head).map((b) => b.name);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const target = base || (project.defaultBranch && project.defaultBranch !== head ? project.defaultBranch : locals[0]) || '';
  const [created, setCreated] = useState<{ url: string; number: number } | null>(null);
  const create = useMutation({ mutationFn: () => api<{ url: string; number: number }>(url(project, 'pull-request'), { body: { title, body: body || undefined, head, base: target } }), onSuccess: setCreated });
  const close = (o: boolean) => { if (!o) { setCreated(null); create.reset(); } onOpenChange(o); };
  return (
    <Dialog open={open} onOpenChange={close} title="Create pull request" description={created ? undefined : <>Pushes <span className="font-mono text-fg-2">{head}</span> to origin, then opens a pull request on {project.repoFullName}.</>}>
      {created ? (
        <>
          <p className="text-sm">Pull request #{created.number} is open.</p>
          <a href={created.url} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-xs text-fg underline underline-offset-4">{created.url}</a>
          <DialogFooter><Button variant="primary" onClick={() => close(false)}>Done</Button></DialogFooter>
        </>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Title"><Input autoFocus required maxLength={256} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Description" hint="optional"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
          <Field label="Into (base branch)">
            <Select required value={target} onChange={(e) => setBase(e.target.value)}>
              {[...new Set([project.defaultBranch, ...locals].filter((b): b is string => !!b && b !== head))].map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>
          </Field>
          {create.error ? <p role="alert" className="break-words rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(create.error)}</p> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!title.trim() || !target}><GitPullRequest />Push and create</Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

export function Changes({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const k = keys(project.id);
  const status = useQuery({ queryKey: k.status, queryFn: () => api<GitStatus>(url(project, 'status')), retry: false, refetchInterval: 10_000 });
  const [file, setFile] = useState<string | null>(null);
  const diff = useQuery({ queryKey: [...k.all, 'diff', file], enabled: !!status.data?.isRepo && status.data.files.length > 0, retry: false,
    queryFn: () => api<{ diff: string; truncated: boolean }>(url(project, `diff${file ? `?path=${encodeURIComponent(file)}` : ''}`)) });
  const branches = useQuery({ queryKey: k.branches, enabled: !!status.data?.isRepo, queryFn: () => api<GitBranch[]>(url(project, 'branches')) });
  const [message, setMessage] = useState('');
  const [pr, setPr] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: k.all });
  const commit = useMutation({
    mutationFn: () => api<{ sha: string }>(url(project, 'commit'), { body: { message } }),
    onSuccess: (r) => { setMessage(''); setFile(null); toast(`Committed ${r.sha.slice(0, 7)}`); void refresh(); },
    onError: (e) => toast.error('Commit failed', { description: errMsg(e) }),
  });
  const branch = status.data?.branch ?? null;
  const push = useMutation({
    mutationFn: () => api(url(project, 'push'), { body: { branch } }),
    onSuccess: () => { toast(`Pushed ${branch} to origin`); void refresh(); },
    onError: (e) => toast.error('Push failed', { description: errMsg(e) }),
  });

  if (status.isPending) return <SkeletonRows />;
  if (status.error) return <ErrorState error={status.error} onRetry={() => status.refetch()} />;
  if (!status.data.isRepo) return <EmptyState icon={FileDiff} title="Not a git repository">This directory is not under version control, so there are no changes, commits or branches to show. Files and commands still work.</EmptyState>;
  const files = status.data.files;
  return (
    <div className="flex h-full flex-col @3xl:flex-row">
      <div className="flex max-h-[45%] shrink-0 flex-col border-b @3xl:max-h-none @3xl:w-80 @3xl:border-b-0 @3xl:border-r">
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs text-fg-3">
          <span className="font-mono">{branch ?? 'detached HEAD'} · {files.length} changed</span>
          <Button variant="ghost" size="icon" aria-label="Refresh changes" onClick={() => refresh()}><RefreshCw className={status.isFetching ? 'animate-spin' : ''} /></Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {files.length === 0 ? <li className="px-3 py-6 text-center text-sm text-fg-3">The working tree is clean.</li> : files.map((f) => (
            <li key={f.path}>
              <button onClick={() => setFile(file === f.path ? null : f.path)} aria-pressed={file === f.path}
                className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-raised', file === f.path && 'bg-active')}>
                <span className="w-5 shrink-0 font-mono text-2xs text-fg-3">{f.status}</span>
                <span className="min-w-0 truncate font-mono text-xs" title={f.path}>{f.path}</span>
              </button>
            </li>
          ))}
        </ul>
        {canEdit && (
          <form className="shrink-0 space-y-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); commit.mutate(); }}>
            <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message (commits every change)" aria-label="Commit message" className="min-h-14 text-sm" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="primary" loading={commit.isPending} disabled={!message.trim() || files.length === 0}><GitCommitHorizontal />Commit</Button>
              <Button size="sm" loading={push.isPending} disabled={!branch} onClick={() => push.mutate()}><Upload />Push</Button>
              <Button size="sm" disabled={!branch || !project.repoFullName || !project.credentialId} onClick={() => setPr(true)}
                title={!project.repoFullName || !project.credentialId ? 'Needs a project cloned from GitHub with a credential' : undefined}><GitPullRequest />Pull request</Button>
            </div>
          </form>
        )}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {files.length === 0 ? <EmptyState icon={FileDiff} title="No changes">Edit files, or let an agent work in this directory, and the diff appears here.</EmptyState>
          : diff.isPending ? <SkeletonRows /> : diff.error ? <ErrorState error={diff.error} onRetry={() => diff.refetch()} />
          : diff.data.diff ? <>{diff.data.truncated ? <p className="border-b px-3 py-1.5 text-xs text-fg-3">Diff truncated — select a file to see it in full.</p> : null}<Diff text={diff.data.diff} /></>
          : <EmptyState icon={FileDiff} title="Nothing to diff yet">{file ? `${file} is new and untracked` : 'The changes are new, untracked files'} — they will be included when you commit.</EmptyState>}
      </div>
      {branch ? <PullRequestDialog project={project} head={branch} branches={branches.data ?? []} open={pr} onOpenChange={setPr} /> : null}
    </div>
  );
}

export function Commits({ project }: { project: Project }) {
  const q = useQuery({ queryKey: [...keys(project.id).all, 'commits'], queryFn: () => api<GitCommit[]>(url(project, 'commits?limit=100')), retry: false });
  if (q.isPending) return <SkeletonRows />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return <EmptyState icon={GitCommitHorizontal} title="No commits yet">This repository has no history on the current branch.</EmptyState>;
  return (
    <table className="w-full border-collapse">
      <thead><tr><Th>Commit</Th><Th>Subject</Th><Th className="hidden @xl:table-cell">Author</Th><Th>When</Th></tr></thead>
      <tbody>{q.data.map((c) => (
        <tr key={c.sha} className="transition-colors hover:bg-raised">
          <Td className="font-mono text-xs text-fg-2">{c.sha.slice(0, 7)}</Td>
          <Td className="w-full max-w-0"><div className="truncate text-sm" title={c.subject}>{c.subject}</div></Td>
          <Td className="hidden whitespace-nowrap text-sm text-fg-2 @xl:table-cell">{c.author}</Td>
          <Td className="whitespace-nowrap text-xs text-fg-3">{ago(c.date)}</Td>
        </tr>
      ))}</tbody>
    </table>
  );
}

export function Branches({ project, canEdit, onCheckout, busy }: { project: Project; canEdit: boolean; onCheckout: (ref: string) => void; busy: boolean }) {
  const q = useQuery({ queryKey: keys(project.id).branches, queryFn: () => api<GitBranch[]>(url(project, 'branches')), retry: false });
  if (q.isPending) return <SkeletonRows />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0) return <EmptyState icon={BranchIcon} title="No branches yet">Branches appear after the first commit.</EmptyState>;
  const locals = new Set(q.data.filter((b) => !b.remote).map((b) => b.name));
  return (
    <table className="w-full border-collapse">
      <thead><tr><Th>Branch</Th><Th>Head</Th><Th /></tr></thead>
      <tbody>{q.data.map((b) => {
        // A remote branch is checked out as a local tracking branch of the same name.
        const local = b.remote ? b.name.split('/').slice(1).join('/') : b.name;
        return (
          <tr key={`${b.remote}-${b.name}`} className="transition-colors hover:bg-raised">
            <Td><span className="flex items-center gap-2 font-mono text-xs">{b.name}{b.current ? <Badge>current</Badge> : null}{b.remote ? <Badge>remote</Badge> : null}{b.name === project.defaultBranch ? <Badge>default</Badge> : null}</span></Td>
            <Td className="font-mono text-xs text-fg-3">{b.sha}</Td>
            <Td className="py-0 text-right">{canEdit && !b.current && !(b.remote && locals.has(local)) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCheckout(local)}>Check out</Button> : null}</Td>
          </tr>
        );
      })}</tbody>
    </table>
  );
}

export function Worktrees({ project, server, canEdit }: { project: Project; server: Server | undefined; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = [...keys(project.id).all, 'worktrees'];
  const q = useQuery({ queryKey: key, queryFn: () => api<GitWorktree[]>(url(project, 'worktrees')), retry: false });
  const [branch, setBranch] = useState('');
  const [removing, setRemoving] = useState<GitWorktree | null>(null);
  const add = useMutation({
    mutationFn: () => api<{ path: string }>(url(project, 'worktrees'), { body: { branch: branch.trim() } }),
    onSuccess: (r) => { setBranch(''); toast('Worktree created', { description: r.path }); void qc.invalidateQueries({ queryKey: keys(project.id).all }); },
    onError: (e) => toast.error('Could not create the worktree', { description: errMsg(e) }),
  });
  if (q.isPending) return <SkeletonRows />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      {canEdit && (
        <form className="flex flex-wrap items-center gap-2 border-b px-3 py-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch for a new worktree, e.g. agent/fix-tests" aria-label="Worktree branch" className="h-7 max-w-sm font-mono text-sm" spellCheck={false} />
          <Button size="sm" type="submit" loading={add.isPending} disabled={!branch.trim()}>Add worktree</Button>
          <span className="text-xs text-fg-3">An isolated checkout of the same repository — give each agent its own.</span>
        </form>
      )}
      <table className="w-full border-collapse">
        <thead><tr><Th>Path</Th><Th>Branch</Th><Th className="hidden @xl:table-cell">Head</Th><Th /></tr></thead>
        <tbody>{q.data.map((w) => (
          <tr key={w.path} className="transition-colors hover:bg-raised">
            <Td className="w-full max-w-0"><div className="truncate font-mono text-xs" title={w.path}>{w.path}</div></Td>
            <Td className="whitespace-nowrap font-mono text-xs">{w.branch ?? 'detached'}{w.path === project.path ? <Badge className="ml-2">main checkout</Badge> : null}</Td>
            <Td className="hidden font-mono text-xs text-fg-3 @xl:table-cell">{w.sha}</Td>
            <Td className="py-0 text-right">
              <div className="flex justify-end gap-0.5">
                <Button size="icon" variant="ghost" disabled={!server || server.status !== 'online'} aria-label={`Open terminal in ${w.path}`} onClick={() => server && newTerminal(server, w.path)}><SquareTerminal /></Button>
                <Button size="icon" variant="ghost" aria-label={`Browse files in ${w.path}`} onClick={() => openFiles(project.serverId, w.path)}><FolderTree /></Button>
                {canEdit && w.path !== project.path ? <Button size="icon" variant="ghost" aria-label={`Remove worktree ${w.path}`} onClick={() => setRemoving(w)}><Trash2 /></Button> : null}
              </div>
            </Td>
          </tr>
        ))}</tbody>
      </table>
      <ConfirmDialog open={!!removing} onOpenChange={() => setRemoving(null)} title="Remove this worktree?" confirmLabel="Remove worktree"
        description={<>The directory <span className="break-all font-mono text-xs text-fg-2">{removing?.path}</span> is deleted, including uncommitted changes in it. The branch itself is kept.</>}
        onConfirm={async () => { await api(url(project, 'worktrees'), { method: 'DELETE', body: { path: removing!.path } }); await qc.invalidateQueries({ queryKey: keys(project.id).all }); }} />
    </>
  );
}
