'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, Power, RefreshCw, Skull, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ProcessInfo } from '@viscosity/protocol';
import { Badge, EmptyState, ErrorState, Meter, Segmented, SkeletonRows, Sparkline, Status, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { newTerminal, openFiles } from '@/lib/actions';
import { api } from '@/lib/api';
import { ago, bytes, dateTime, duration, pct } from '@/lib/format';
import { useMe, useMetrics } from '@/lib/queries';
import { renameTab, useUi } from '@/lib/store';
import type { ServerDetail } from '@/lib/types';
import { useTopic } from '@/lib/ws';
import { ServerMenu } from './servers';

function MetricCard({ label, value, sub, values, max, meter }: { label: string; value: string; sub: string; values?: number[]; max?: number; meter?: number }) {
  return (
    <div className="rounded-xl border bg-panel p-4">
      <div className="text-xs uppercase tracking-[0.14em] text-fg-3">{label}</div>
      <div className="tnum mt-1.5 font-mono text-xl tracking-tight">{value}</div>
      <div className="tnum mt-0.5 truncate font-mono text-xs text-fg-3">{sub}</div>
      {values ? <Sparkline values={values} max={max} className="mt-2 h-10 text-fg-2" /> : null}
      {meter !== undefined ? <Meter value={meter} className="mt-6" /> : null}
    </div>
  );
}

function Processes({ serverId, online, canKill }: { serverId: string; online: boolean; canKill: boolean }) {
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<{ p: ProcessInfo; signal: 'TERM' | 'KILL' } | null>(null);
  const q = useQuery({ queryKey: ['processes', serverId], enabled: online, refetchInterval: 5000, queryFn: () => api<ProcessInfo[]>(`/api/servers/${serverId}/processes`) });
  if (!online) return <EmptyState icon={Power} title="Server offline">Processes can only be listed while the worker is connected.</EmptyState>;
  if (q.isPending) return <SkeletonRows />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data.filter((p) => !filter || `${p.pid} ${p.user} ${p.command}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, user or PID" className="h-7 max-w-xs" aria-label="Filter processes" />
        <span className="font-mono text-xs text-fg-3">{rows.length} of {q.data.length} · refreshes every 5 s</span>
      </div>
      <table className="w-full border-collapse">
        <thead><tr><Th>PID</Th><Th>User</Th><Th>CPU</Th><Th>Memory</Th><Th className="hidden md:table-cell">Elapsed</Th><Th>Command</Th><Th /></tr></thead>
        <tbody>
          {rows.slice(0, 300).map((p) => (
            <tr key={p.pid} className="group transition-colors hover:bg-raised">
              <Td className="tnum font-mono text-xs">{p.pid}</Td>
              <Td className="text-sm text-fg-2">{p.user}</Td>
              <Td className="tnum whitespace-nowrap font-mono text-xs">{p.cpu.toFixed(1)}%</Td>
              <Td className="tnum whitespace-nowrap font-mono text-xs">{bytes(p.rss)}</Td>
              <Td className="tnum hidden font-mono text-xs text-fg-3 md:table-cell">{p.elapsed}</Td>
              <Td className="max-w-0 w-full"><div className="truncate font-mono text-xs text-fg-2" title={p.command}>{p.command}</div></Td>
              <Td className="py-0 text-right">
                {canKill ? (
                  <div className="flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <Button size="sm" variant="ghost" onClick={() => setTarget({ p, signal: 'TERM' })}>Stop</Button>
                    <Button size="icon" variant="ghost" aria-label={`Force kill ${p.pid}`} onClick={() => setTarget({ p, signal: 'KILL' })}><Skull /></Button>
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConfirmDialog open={!!target} onOpenChange={() => setTarget(null)} confirmLabel={target?.signal === 'KILL' ? 'Force kill' : 'Send SIGTERM'}
        title={`${target?.signal === 'KILL' ? 'Force kill' : 'Stop'} process ${target?.p.pid}?`}
        description={<span className="break-all font-mono text-xs">{target?.p.command}</span>}
        onConfirm={async () => {
          await api(`/api/servers/${serverId}/processes/${target!.p.pid}/kill`, { body: { signal: target!.signal } });
          toast(`SIG${target!.signal} sent to ${target!.p.pid}`);
          await q.refetch();
        }} />
    </>
  );
}

function Logs({ serverId, online }: { serverId: string; online: boolean }) {
  const [unit, setUnit] = useState('');
  const [applied, setApplied] = useState('');
  const q = useQuery({ queryKey: ['logs', serverId, applied], enabled: online, queryFn: () => api<{ text: string }>(`/api/servers/${serverId}/logs?lines=300${applied ? `&unit=${encodeURIComponent(applied)}` : ''}`) });
  if (!online) return <EmptyState icon={Power} title="Server offline">Logs can only be read while the worker is connected.</EmptyState>;
  return (
    <div className="flex h-full flex-col">
      <form className="flex items-center gap-2 border-b px-3 py-2" onSubmit={(e) => { e.preventDefault(); setApplied(unit.trim()); }}>
        <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="systemd unit (blank = whole journal)" className="h-7 max-w-xs font-mono" aria-label="systemd unit" />
        <Button size="sm" type="submit">Show</Button>
        <Button size="icon" variant="ghost" aria-label="Refresh logs" onClick={() => q.refetch()}><RefreshCw className={q.isFetching ? 'animate-spin' : ''} /></Button>
      </form>
      {q.isPending ? <SkeletonRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-fg-2">{q.data.text || 'No log lines returned.'}</pre>}
    </div>
  );
}

export default function ServerDetailView({ id }: { id?: string }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const [tab, setTab] = useState<'processes' | 'logs' | 'connections'>('processes');
  const [reboot, setReboot] = useState(false);
  const q = useQuery({ queryKey: ['server', id], enabled: !!id, queryFn: () => api<ServerDetail>(`/api/servers/${id}`) });
  useTopic<{ id?: string }>('servers', (e) => { if (!e.id || e.id === id) void qc.invalidateQueries({ queryKey: ['server', id] }); });
  const server = q.data;
  const online = server?.status === 'online';
  const { history, latest } = useMetrics(id ?? null, !!online, server?.history);
  useEffect(() => { if (id) useUi.getState().select({ kind: 'server', id }); }, [id]);
  useEffect(() => { if (server && id) renameTab({ kind: 'server', id }, server.name); }, [server?.name, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isPending) return <SkeletonRows rows={8} />;
  if (q.error || !server) return <ErrorState error={q.error ?? new Error('server not found')} onRetry={() => q.refetch()} />;
  const sys = server.system;
  const caps = sys ? Object.entries(sys.capabilities).filter(([, v]) => v).map(([k]) => k) : [];

  return (
    <View flush title={<span className="flex items-center gap-3">{server.name}<Status status={server.status} /></span>}
      subtitle={sys ? `${sys.hostname} · ${sys.distro} · ${sys.cpuCores} cores · ${bytes(sys.memTotal)} · worker v${sys.workerVersion} as ${sys.user}` : 'Not enrolled yet'}
      actions={<>
        <Button disabled={!online} onClick={() => newTerminal(server)}><SquareTerminal />Terminal</Button>
        <Button disabled={!online} onClick={() => openFiles(server.id)}><FolderTree />Files</Button>
        {me?.role === 'admin' && sys?.capabilities.reboot ? <Button disabled={!online} variant="danger" onClick={() => setReboot(true)}><Power />Reboot</Button> : null}
        <ServerMenu server={server} />
      </>}>
      <div className="flex h-full flex-col">
        {!online && (
          <div role="status" className="border-b bg-raised px-4 py-2.5 text-sm text-fg-2">
            {server.status === 'pending'
              ? 'This server has not been enrolled. Use the ··· menu to get a fresh install command.'
              : `The worker is disconnected (last seen ${ago(server.lastSeenAt)}). Nothing below is live, and operations will fail until it reconnects.`}
          </div>
        )}
        {latest ? (
          <div className="grid shrink-0 grid-cols-2 gap-3 border-b p-4 xl:grid-cols-4">
            <MetricCard label="CPU" value={pct(latest.cpu)} sub={`load ${latest.load.map((l) => l.toFixed(2)).join(' ')}`} values={history.map((m) => m.cpu)} max={100} />
            <MetricCard label="Memory" value={pct((1 - latest.memAvailable / latest.memTotal) * 100)} sub={`${bytes(latest.memTotal - latest.memAvailable)} of ${bytes(latest.memTotal)}`} values={history.map((m) => m.memTotal - m.memAvailable)} max={latest.memTotal} />
            <MetricCard label="Disk /" value={pct((latest.diskUsed / latest.diskTotal) * 100)} sub={`${bytes(latest.diskUsed)} of ${bytes(latest.diskTotal)}`} meter={(latest.diskUsed / latest.diskTotal) * 100} />
            <MetricCard label="Network" value={`↓ ${bytes(latest.netRxBps)}/s`} sub={`↑ ${bytes(latest.netTxBps)}/s · up ${duration(latest.uptime)}`} values={history.map((m) => m.netRxBps + m.netTxBps)} />
          </div>
        ) : online ? <div className="border-b p-4"><SkeletonRows rows={2} /></div> : null}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <Segmented value={tab} onChange={setTab} options={[{ value: 'processes', label: 'Processes' }, { value: 'logs', label: 'System logs' }, { value: 'connections', label: 'Connections' }]} />
          <div className="flex flex-wrap gap-1">{caps.map((c) => <Badge key={c}>{c}</Badge>)}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'processes' ? <Processes serverId={server.id} online={!!online} canKill={me?.role !== 'viewer'} />
            : tab === 'logs' ? <Logs serverId={server.id} online={!!online} />
            : server.connections.length === 0 ? <EmptyState icon={Power} title="No connections yet">The worker has never connected.</EmptyState> : (
              <table className="w-full border-collapse">
                <thead><tr><Th>Connected</Th><Th>Disconnected</Th><Th>From</Th><Th>Worker</Th></tr></thead>
                <tbody>{server.connections.map((c) => (
                  <tr key={c.id}><Td className="text-sm">{dateTime(c.connectedAt)}</Td><Td className="text-sm text-fg-2">{c.disconnectedAt ? dateTime(c.disconnectedAt) : <Status status="online" />}</Td>
                    <Td className="font-mono text-xs">{c.remoteIp ?? '—'}</Td><Td className="font-mono text-xs">v{c.workerVersion}</Td></tr>
                ))}</tbody>
              </table>
            )}
        </div>
      </div>
      <ConfirmDialog open={reboot} onOpenChange={setReboot} title={`Reboot ${server.name}?`} confirmLabel="Reboot now" typeToConfirm={server.name}
        description="Every process on the machine stops, including running agents, terminals and browser sessions. The worker reconnects on its own once the machine is back."
        onConfirm={async () => { await api(`/api/servers/${server.id}/reboot`, { body: { confirm: server.name } }); toast(`Reboot requested for ${server.name}`); }} />
    </View>
  );
}
