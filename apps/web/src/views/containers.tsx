'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Braces, MoreHorizontal, Play, RefreshCw, RotateCw, ScrollText, ServerOff, Square } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Container, ContainerStats } from '@viscosity/protocol';
import { pickServer, ServerPicker } from '@/components/server-picker';
import { EmptyState, ErrorState, SkeletonRows, Status, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/menu';
import { api, ApiError, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { bytes } from '@/lib/format';
import { useServers } from '@/lib/queries';
import { shell, useUi } from '@/lib/store';
import type { Server } from '@/lib/types';

type Action = 'start' | 'stop' | 'restart';

function LogsDialog({ serverId, container, onClose }: { serverId: string; container: Container; onClose: () => void }) {
  const logs = useQuery({ queryKey: ['container-logs', serverId, container.id], staleTime: 0, gcTime: 0, retry: false,
    queryFn: () => api<{ text: string }>(`/api/servers/${serverId}/containers/${container.id}/logs?tail=500`) });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [logs.data, logs.dataUpdatedAt]);
  return (
    <Dialog open onOpenChange={onClose} wide title={`Logs · ${container.name}`} description="Last 500 lines (stdout and stderr).">
      <div className="mb-2 flex justify-end"><Button size="sm" loading={logs.isFetching} onClick={() => logs.refetch()}><RefreshCw />Refresh</Button></div>
      {logs.isPending ? <SkeletonRows rows={6} /> : logs.error ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : (
        <pre tabIndex={0} className="max-h-[52vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line-strong bg-bg p-3 font-mono text-xs leading-relaxed text-fg-2">
          {logs.data.text || <span className="text-fg-3">This container has not written any output.</span>}
          <div ref={end} />
        </pre>
      )}
    </Dialog>
  );
}

function InspectDialog({ serverId, container, onClose }: { serverId: string; container: Container; onClose: () => void }) {
  const info = useQuery({ queryKey: ['container-inspect', serverId, container.id], staleTime: 0, gcTime: 0, retry: false,
    queryFn: () => api<unknown>(`/api/servers/${serverId}/containers/${container.id}`) });
  return (
    <Dialog open onOpenChange={onClose} wide title={`Inspect · ${container.name}`} description={<span className="font-mono">{container.image}</span>}>
      {info.isPending ? <SkeletonRows rows={6} /> : info.error ? <ErrorState error={info.error} onRetry={() => info.refetch()} /> : (
        <pre tabIndex={0} className="max-h-[56vh] overflow-auto rounded-lg border border-line-strong bg-bg p-3 font-mono text-xs leading-relaxed text-fg-2">{JSON.stringify(info.data, null, 2)}</pre>
      )}
    </Dialog>
  );
}

function ContainerTable({ server }: { server: Server }) {
  const sid = server.id;
  const qc = useQueryClient();
  const select = useUi((s) => s.select);
  const selection = useUi((s) => s.selection);
  const [confirming, setConfirming] = useState<{ c: Container; action: Action } | null>(null);
  const [logs, setLogs] = useState<Container | null>(null);
  const [inspect, setInspect] = useState<Container | null>(null);
  // A server without Docker answers 501; polling that again would be noise.
  const list = useQuery({ queryKey: ['containers', sid], queryFn: () => api<Container[]>(`/api/servers/${sid}/containers`),
    retry: false, refetchInterval: (q) => (q.state.error ? false : 5000) });
  const stats = useQuery({ queryKey: ['container-stats', sid], enabled: !!list.data?.length, queryFn: () => api<ContainerStats[]>(`/api/servers/${sid}/containers/stats`),
    retry: false, refetchInterval: (q) => (q.state.error ? false : 5000) });
  const act = useMutation({
    mutationFn: ({ c, action }: { c: Container; action: Action }) => api(`/api/servers/${sid}/containers/${c.id}/${action}`, { method: 'POST' }),
    onSuccess: (_r, { c, action }) => { toast(`${c.name}: ${action} completed`); void qc.invalidateQueries({ queryKey: ['containers', sid] }); },
    onError: (e, { c, action }) => toast.error(`Could not ${action} ${c.name}`, { description: errMsg(e) }),
  });

  if (list.isPending) return <SkeletonRows />;
  if (list.error) {
    if (!(list.error instanceof ApiError && list.error.status === 501)) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
    return (
      <EmptyState icon={Boxes} title="Docker is not available on this server" action={<Button onClick={() => list.refetch()} loading={list.isFetching}><RefreshCw />Check again</Button>}>
        The worker on {server.name} reported: <span className="font-mono text-fg-2">{list.error.message}</span>. Install Docker and give the worker's account access to it to manage containers here.
      </EmptyState>
    );
  }
  if (list.data.length === 0) return <EmptyState icon={Boxes} title="No containers">Docker is running on {server.name}, but it has no containers (running or stopped).</EmptyState>;

  const statFor = (c: Container) => stats.data?.find((s) => c.id.startsWith(s.id) || s.id.startsWith(c.id));
  const groups = new Map<string, Container[]>();
  for (const c of list.data) groups.set(c.composeProject ?? '', [...(groups.get(c.composeProject ?? '') ?? []), c]);
  const ordered = [...groups].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const run = (c: Container, action: Action) => (action === 'start' ? act.mutate({ c, action }) : setConfirming({ c, action }));

  return (
    <>
      <table className="w-full border-collapse text-base">
        <thead><tr><Th>Container</Th><Th>State</Th><Th className="hidden @3xl:table-cell">Ports</Th><Th className="w-20 text-right">CPU</Th><Th className="hidden w-40 text-right @md:table-cell">Memory</Th><Th className="w-28" /></tr></thead>
        <tbody>
          {ordered.map(([project, containers]) => (
            <Fragment key={project}>
              {(groups.size > 1 || project) ? (
                <tr><td colSpan={6} className="border-b bg-panel px-3 py-1.5 text-2xs uppercase tracking-[0.14em] text-fg-3">{project ? <>Compose · <span className="normal-case tracking-normal text-fg-2">{project}</span></> : 'Standalone'}</td></tr>
              ) : null}
              {containers.map((c) => {
                const st = statFor(c);
                const running = c.state === 'running';
                const busy = act.isPending && act.variables?.c.id === c.id;
                const selected = selection?.kind === 'container' && selection.id === c.name;
                return (
                  <tr key={c.id} tabIndex={0} aria-selected={selected} className={cn('cursor-default transition-colors hover:bg-raised focus-visible:bg-raised', selected && 'bg-raised')}
                    onClick={() => {
                      select({ kind: 'container', id: c.name, serverId: sid, data: { Image: c.image, State: c.state, Status: c.status, Health: c.health ?? 'no healthcheck', Ports: c.ports || '—', Compose: c.composeProject ?? '—', Created: c.createdAt, ID: c.id.slice(0, 12), Server: server.name } });
                      shell.showInspector();
                    }}>
                    <Td>
                      <div className="font-medium">{c.name}</div>
                      <div className="truncate font-mono text-xs text-fg-3">{c.image}</div>
                    </Td>
                    <Td>
                      <Status status={c.state} />
                      <div className="text-xs text-fg-3">{c.status}{c.health ? ` · ${c.health}` : ''}</div>
                    </Td>
                    <Td className="hidden max-w-56 truncate font-mono text-xs text-fg-2 @3xl:table-cell">{c.ports || '—'}</Td>
                    <Td className="tnum text-right font-mono text-xs">{st ? `${st.cpuPct.toFixed(1)}%` : <span className="text-fg-4">—</span>}</Td>
                    <Td className="tnum hidden text-right font-mono text-xs @md:table-cell">{st ? `${bytes(st.memUsed)} / ${bytes(st.memLimit)}` : <span className="text-fg-4">—</span>}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                        {running
                          ? <Button variant="ghost" size="icon" loading={busy} aria-label={`Stop ${c.name}`} onClick={() => run(c, 'stop')}><Square /></Button>
                          : <Button variant="ghost" size="icon" loading={busy} aria-label={`Start ${c.name}`} onClick={() => run(c, 'start')}><Play /></Button>}
                        <Button variant="ghost" size="icon" aria-label={`Logs for ${c.name}`} onClick={() => setLogs(c)}><ScrollText /></Button>
                        <Menu trigger={<Button variant="ghost" size="icon" aria-label={`More actions for ${c.name}`}><MoreHorizontal /></Button>}>
                          <MenuItem icon={RotateCw} onSelect={() => run(c, 'restart')}>Restart…</MenuItem>
                          <MenuItem icon={ScrollText} onSelect={() => setLogs(c)}>Logs</MenuItem>
                          <MenuItem icon={Braces} onSelect={() => setInspect(c)}>Inspect</MenuItem>
                          <MenuSeparator />
                          {running ? <MenuItem icon={Square} danger onSelect={() => run(c, 'stop')}>Stop…</MenuItem> : <MenuItem icon={Play} onSelect={() => run(c, 'start')}>Start</MenuItem>}
                        </Menu>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
      {stats.error ? <p role="alert" className="border-b px-3 py-2 text-xs text-fg-3">Resource usage is unavailable: {errMsg(stats.error)}</p> : null}
      <ConfirmDialog open={!!confirming} onOpenChange={() => setConfirming(null)} confirmLabel={confirming?.action === 'stop' ? 'Stop container' : 'Restart container'}
        title={`${confirming?.action === 'stop' ? 'Stop' : 'Restart'} ${confirming?.c.name ?? ''}?`}
        description={confirming?.action === 'stop' ? `Whatever ${confirming.c.name} serves on ${server.name} goes down until it is started again.` : `${confirming?.c.name} will be briefly unavailable on ${server.name} while it restarts.`}
        onConfirm={async () => { const { c, action } = confirming!; await act.mutateAsync({ c, action }); }} />
      {logs ? <LogsDialog serverId={sid} container={logs} onClose={() => setLogs(null)} /> : null}
      {inspect ? <InspectDialog serverId={sid} container={inspect} onClose={() => setInspect(null)} /> : null}
    </>
  );
}

export default function Containers() {
  const servers = useServers();
  const [picked, setPicked] = useState<string | null>(null);
  const server = pickServer(servers.data, picked);
  return (
    <View flush title="Containers" subtitle={server ? `Docker on ${server.name}` : undefined}
      actions={servers.data?.length ? <ServerPicker servers={servers.data} value={server?.id ?? null} onChange={setPicked} /> : null}>
      {servers.isPending ? <SkeletonRows /> : servers.error ? <ErrorState error={servers.error} onRetry={() => servers.refetch()} />
        : !server ? <EmptyState icon={Boxes} title="No server selected">Enroll a server to see the Docker containers running on it.</EmptyState>
        : server.status !== 'online' ? <EmptyState icon={ServerOff} title={`${server.name} is ${server.status === 'pending' ? 'not enrolled yet' : 'offline'}`}>Container state is read live from the server. It will appear when the worker is connected.</EmptyState>
        : <ContainerTable key={server.id} server={server} />}
    </View>
  );
}
