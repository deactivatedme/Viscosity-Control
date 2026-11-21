'use client';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NewProjectDialog } from '@/components/projects/new-project-dialog';
import type { Project } from '@/components/projects/types';
import { EmptyState, ErrorState, SkeletonRows, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useMe, useServers } from '@/lib/queries';
import { openTab, useUi } from '@/lib/store';

export default function Projects() {
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/api/projects'), refetchInterval: 20_000 });
  const servers = useServers().data ?? [];
  const canEdit = useMe().data?.role !== 'viewer';
  const intent = useUi((s) => s.intent);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (intent === 'new-project') { setCreating(true); useUi.getState().setIntent(null); } }, [intent]);
  const open = (p: Project) => openTab({ kind: 'project', id: p.id }, p.name);

  const add = canEdit ? <Button variant="primary" onClick={() => setCreating(true)}><Plus />New project</Button> : null;
  return (
    <View flush title="Projects" subtitle={q.data ? `${q.data.length} source tree${q.data.length === 1 ? '' : 's'} across your servers` : undefined} actions={add}>
      {q.isPending ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data.length === 0 ? (
          <EmptyState icon={FolderGit2} title="No projects yet" action={add}>
            Clone a GitHub repository onto a server, or register a directory that is already there. Then review changes, run builds and tests, and open pull requests from here.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse">
            <thead><tr><Th>Project</Th><Th className="hidden @xl:table-cell">Server</Th><Th className="hidden @3xl:table-cell">Repository</Th><Th>Working tree</Th><Th /></tr></thead>
            <tbody>
              {q.data.map((p) => (
                <tr key={p.id} tabIndex={0} onDoubleClick={() => open(p)} onKeyDown={(e) => { if (e.key === 'Enter') open(p); }}
                  className="cursor-default transition-colors hover:bg-raised focus-visible:bg-raised">
                  <Td>
                    <button onClick={() => open(p)} className="font-medium hover:underline hover:underline-offset-4">{p.name}</button>
                    <div className="break-all font-mono text-xs text-fg-3">{p.path}</div>
                  </Td>
                  <Td className="hidden text-sm text-fg-2 @xl:table-cell">{servers.find((s) => s.id === p.serverId)?.name ?? '—'}</Td>
                  <Td className="hidden font-mono text-xs text-fg-2 @3xl:table-cell">{p.repoFullName ?? <span className="text-fg-4">—</span>}</Td>
                  <Td>
                    {!p.serverOnline ? <span className="text-sm text-fg-3">server offline</span>
                      : !p.git ? <span className="text-sm text-fg-3">unreadable</span>
                      : !p.git.isRepo ? <span className="text-sm text-fg-3">not a git repository</span>
                      : <><div className="font-mono text-xs">{p.git.branch ?? 'detached'}</div><div className="text-xs text-fg-3">{p.git.changed ? `${p.git.changed} changed` : 'clean'}</div></>}
                  </Td>
                  <Td className="text-right"><Button variant="ghost" size="icon" aria-label={`Open ${p.name}`} onClick={() => open(p)}><SquareArrowOutUpRight /></Button></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </View>
  );
}
