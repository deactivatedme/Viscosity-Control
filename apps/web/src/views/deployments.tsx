'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DeployStatus, EnvBadge, shortSha } from '@/components/deployments/bits';
import { DeploymentDialog } from '@/components/deployments/form';
import type { DeploymentListItem } from '@/components/deployments/types';
import { EmptyState, ErrorState, SkeletonRows, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useMe, useServers } from '@/lib/queries';
import { openTab, useUi } from '@/lib/store';
import { useTopic } from '@/lib/ws';

export default function Deployments() {
  const qc = useQueryClient();
  const canEdit = useMe().data?.role !== 'viewer';
  const servers = useServers().data ?? [];
  const q = useQuery({ queryKey: ['deployments'], queryFn: () => api<DeploymentListItem[]>('/api/deployments') });
  useTopic('deployments', () => void qc.invalidateQueries({ queryKey: ['deployments'] }));
  const intent = useUi((s) => s.intent);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (intent === 'new-deployment') { setCreating(true); useUi.getState().setIntent(null); } }, [intent]);
  const open = (d: { id: string; name: string }) => openTab({ kind: 'deployment', id: d.id }, d.name);

  const add = canEdit ? <Button variant="primary" onClick={() => setCreating(true)}><Plus />New deployment</Button> : null;
  return (
    <View flush title="Deployments" subtitle="Which application runs on which server, what version, and whether it is healthy." actions={add}>
      {q.isPending ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data.length === 0 ? (
          <EmptyState icon={Rocket} title="No deployments yet" action={add}>
            Point a deployment at a directory with a Docker Compose file on one of your servers. Deploys run on the server, are logged, health-checked, and can be rolled back to any earlier commit.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse">
            <thead><tr><Th>Application</Th><Th>Environment</Th><Th>Server</Th><Th>Status</Th><Th className="hidden @xl:table-cell">Version</Th><Th className="hidden @3xl:table-cell">Last deployed</Th><Th /></tr></thead>
            <tbody>
              {q.data.map((d) => {
                const server = servers.find((s) => s.id === d.serverId);
                return (
                  <tr key={d.id} tabIndex={0} onDoubleClick={() => open(d)} onKeyDown={(e) => { if (e.key === 'Enter') open(d); }}
                    className="cursor-default transition-colors hover:bg-raised focus-visible:bg-raised">
                    <Td><div className="font-medium">{d.name}</div><div className="font-mono text-xs text-fg-3">{d.workdir}</div></Td>
                    <Td><EnvBadge environment={d.environment} /></Td>
                    <Td className="text-sm">{server?.name ?? '—'}{d.serverOnline ? null : <div className="text-xs text-fg-3">offline</div>}</Td>
                    <Td><DeployStatus status={d.status} /></Td>
                    <Td className="hidden font-mono text-xs text-fg-2 @xl:table-cell">{shortSha(d.current?.version)}</Td>
                    <Td className="hidden text-sm text-fg-2 @3xl:table-cell">{d.current?.finishedAt ? ago(d.current.finishedAt) : 'never'}</Td>
                    <Td className="text-right"><Button size="sm" onClick={() => open(d)}>Open</Button></Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      <DeploymentDialog open={creating} onOpenChange={setCreating} onSaved={open} />
    </View>
  );
}
