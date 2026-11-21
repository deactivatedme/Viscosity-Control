'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FsEntry } from '@viscosity/protocol';
import { Segmented, Skeleton } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { useCredentials, useServers } from '@/lib/queries';
import { openTab } from '@/lib/store';
import type { GithubRepo, Project } from './types';

type Source = 'github' | 'url' | 'existing';
const repoName = (url: string) => url.replace(/\/+$/, '').split('/').pop()?.replace(/\.git$/, '') ?? '';

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const listId = useId();
  const servers = useServers().data ?? [];
  const githubCreds = (useCredentials().data ?? []).filter((c) => c.kind === 'github');
  const [serverId, setServerId] = useState('');
  const [source, setSource] = useState<Source>('github');
  const [credentialId, setCredentialId] = useState('');
  const [credentialIdForUrl, setCredentialIdForUrl] = useState('');
  const [filter, setFilter] = useState('');
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [cloneUrl, setCloneUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [touched, setTouched] = useState({ name: false, path: false });

  const server = servers.find((s) => s.id === serverId) ?? servers.find((s) => s.status === 'online') ?? servers[0];
  const root = server?.system?.roots[0] ?? '';
  useEffect(() => { if (open && !serverId && server) setServerId(server.id); }, [open, serverId, server]);
  useEffect(() => { if (!credentialId && githubCreds[0]) setCredentialId(githubCreds[0].id); }, [credentialId, githubCreds]);

  const repos = useQuery({
    queryKey: ['github-repos', credentialId], enabled: open && source === 'github' && !!credentialId, retry: false,
    queryFn: () => api<GithubRepo[]>(`/api/github/repos?credentialId=${credentialId}`),
  });
  const shown = useMemo(() => (repos.data ?? []).filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase())), [repos.data, filter]);
  const dirs = useQuery({
    queryKey: ['fs-list', server?.id, root], enabled: open && source === 'existing' && !!root && server?.status === 'online',
    queryFn: () => api<FsEntry[]>(`/api/servers/${server!.id}/fs/list?path=${encodeURIComponent(root)}`),
  });

  // Name and destination follow the chosen repository until the user edits them.
  const suggested = source === 'github' ? (repo ? repoName(repo.fullName) : '') : source === 'url' ? repoName(cloneUrl) : (path.split('/').filter(Boolean).pop() ?? '');
  useEffect(() => {
    if (!touched.name) setName(suggested);
    if (!touched.path && source !== 'existing') setPath(suggested && root ? `${root}/${suggested}` : '');
  }, [suggested, root, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { setRepo(null); setCloneUrl(''); setBranch(''); setName(''); setPath(''); setFilter(''); setTouched({ name: false, path: false }); create.reset(); };
  const create = useMutation({
    mutationFn: () => api<Project>('/api/projects', {
      body: source === 'existing' ? { serverId: server!.id, name, path, mode: 'existing' } : {
        serverId: server!.id, name, path, mode: 'clone', branch: branch.trim() || undefined,
        cloneUrl: source === 'github' ? repo!.cloneUrl : cloneUrl.trim(), repoFullName: source === 'github' ? repo!.fullName : undefined,
        // a URL clone only sends a token when the user picked one (private repository)
        credentialId: (source === 'github' ? credentialId : credentialIdForUrl) || undefined,
      },
    }),
    onSuccess: (p) => { void qc.invalidateQueries({ queryKey: ['projects'] }); onOpenChange(false); reset(); openTab({ kind: 'project', id: p.id }, p.name); },
  });
  const ready = !!server && !!name.trim() && !!path.trim() && (source === 'github' ? !!repo : source === 'url' ? !!cloneUrl.trim() : true);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }} wide title="New project"
      description="A project is a source tree on one of your servers — cloned from a repository, or a directory that is already there.">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-56">
            <Field label="Server">
              <Select value={server?.id ?? ''} onChange={(e) => setServerId(e.target.value)} required>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'online' ? '' : s.status === 'pending' ? ' (not enrolled)' : ' (offline)'}</option>)}
              </Select>
            </Field>
          </div>
          <Segmented<Source> value={source} onChange={(v) => { setSource(v); setTouched({ name: false, path: false }); }}
            options={[{ value: 'github', label: 'GitHub' }, { value: 'url', label: 'Clone URL' }, { value: 'existing', label: 'Existing directory' }]} />
        </div>
        {server && server.status !== 'online' ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{server.name} is not connected, so nothing can be cloned or checked there right now.</p> : null}

        {source === 'github' && (githubCreds.length === 0 ? (
          <div className="rounded-lg border border-line-strong bg-bg p-4 text-sm">
            <p className="font-medium">No GitHub credential yet</p>
            <p className="mt-1 text-fg-3">Add a personal access token under Settings → AI providers &amp; secrets (kind: GitHub) to browse your repositories here. Public repositories can be cloned by URL without one.</p>
            <Button size="sm" className="mt-3" onClick={() => { onOpenChange(false); openTab({ kind: 'settings' }, 'Settings'); }}>Open settings</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid gap-3 @md:grid-cols-[12rem_1fr]">
              <Field label="GitHub account">
                <Select value={credentialId} onChange={(e) => { setCredentialId(e.target.value); setRepo(null); }}>{githubCreds.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.hint})</option>)}</Select>
              </Field>
              <Field label="Repository" hint={repos.data ? `${shown.length} of ${repos.data.length}` : undefined}>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-fg-4" />
                  <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter repositories" className="pl-8" aria-label="Filter repositories" />
                </div>
              </Field>
            </div>
            <div role="listbox" aria-label="Repositories" className="max-h-52 overflow-y-auto rounded-lg border border-line-strong bg-bg">
              {repos.isPending ? <div className="space-y-2 p-3"><Skeleton /><Skeleton className="w-2/3" /></div>
                : repos.error ? <p role="alert" className="p-3 text-sm">{errMsg(repos.error)}</p>
                : shown.length === 0 ? <p className="p-3 text-sm text-fg-3">{repos.data.length ? 'No repository matches the filter.' : 'This token cannot see any repositories.'}</p>
                : shown.map((r) => (
                  <button type="button" key={r.fullName} role="option" aria-selected={repo?.fullName === r.fullName} onClick={() => setRepo(r)}
                    className={cn('flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm transition-colors last:border-0 hover:bg-raised', repo?.fullName === r.fullName && 'bg-active')}>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 font-mono text-xs">{r.fullName}{r.private ? <Lock className="size-3 text-fg-3" aria-label="private" /> : null}</span>
                      {r.description ? <span className="block truncate text-xs text-fg-3">{r.description}</span> : null}
                    </span>
                    <span className="shrink-0 text-2xs text-fg-3">{r.pushedAt ? `pushed ${ago(r.pushedAt)}` : ''}</span>
                  </button>
                ))}
            </div>
          </div>
        ))}

        {source === 'url' && (
          <div className="grid gap-3 @md:grid-cols-[1fr_12rem]">
            <Field label="Clone URL" hint="https only"><Input type="url" required value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" className="font-mono text-sm" spellCheck={false} /></Field>
            <Field label="Token" hint="private repos">
              <Select value={credentialIdForUrl} onChange={(e) => setCredentialIdForUrl(e.target.value)}>
                <option value="">None (public)</option>
                {githubCreds.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.hint})</option>)}
              </Select>
            </Field>
          </div>
        )}

        {(source !== 'github' || githubCreds.length > 0) && (
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label={source === 'existing' ? 'Directory' : 'Destination'} hint={root ? `inside ${server?.system?.roots.join(', ')}` : undefined}>
              <Input required value={path} onChange={(e) => { setPath(e.target.value); setTouched((t) => ({ ...t, path: true })); }} list={listId}
                placeholder={root ? `${root}/my-project` : '/srv/project'} className="font-mono text-sm" spellCheck={false} />
              <datalist id={listId}>{dirs.data?.filter((d) => d.type === 'dir').map((d) => <option key={d.path} value={d.path} />)}</datalist>
            </Field>
            <Field label="Name"><Input required maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setTouched((t) => ({ ...t, name: true })); }} /></Field>
            {source !== 'existing' && <Field label="Branch" hint="optional"><Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repo?.defaultBranch ?? 'default branch'} className="font-mono text-sm" spellCheck={false} /></Field>}
          </div>
        )}

        {create.error ? <p role="alert" className="break-words rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(create.error)}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready || server?.status !== 'online'}>
            {create.isPending && source !== 'existing' ? 'Cloning…' : source === 'existing' ? 'Add project' : 'Clone and add'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
