'use client';
import { useQuery } from '@tanstack/react-query';
import { FolderTree, MousePointerClick, SquareTerminal, SquareArrowOutUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, Meter, Skeleton, Status } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { newTerminal, openAgent, openBrowser, openFiles, openServer } from '@/lib/actions';
import { api } from '@/lib/api';
import { ago, bytes, dateTime, duration, pct, usd } from '@/lib/format';
import { useAgents, useBrowsers, useMetrics, useServers } from '@/lib/queries';
import { useUi } from '@/lib/store';
import type { ServerDetail } from '@/lib/types';

export function Row({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs text-fg-3">{k}</dt>
      <dd className={`min-w-0 break-words text-right text-sm ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  );
}
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b px-4 py-3">
      <h3 className="mb-1.5 text-2xs uppercase tracking-[0.14em] text-fg-3">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function ServerInspector({ id }: { id: string }) {
  const server = useServers().data?.find((s) => s.id === id);
  const detail = useQuery({ queryKey: ['server', id], queryFn: () => api<ServerDetail>(`/api/servers/${id}`) });
  const { latest } = useMetrics(id, server?.status === 'online', detail.data?.history);
  if (!server) return <div className="p-4"><Skeleton className="h-24" /></div>;
  const sys = server.system;
  return (
    <>
      <header className="border-b px-4 py-3">
        <h2 className="truncate text-[15px] font-medium tracking-tight">{server.name}</h2>
        <div className="mt-1"><Status status={server.status} /></div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => openServer(server)}><SquareArrowOutUpRight />Open</Button>
          <Button size="sm" disabled={server.status !== 'online'} onClick={() => newTerminal(server)}><SquareTerminal />Terminal</Button>
          <Button size="sm" disabled={server.status !== 'online'} onClick={() => openFiles(server.id)}><FolderTree />Files</Button>
        </div>
      </header>
      {latest ? (
        <Section title="Live">
          {([['CPU', latest.cpu, pct(latest.cpu)], ['Memory', (1 - latest.memAvailable / latest.memTotal) * 100, `${bytes(latest.memTotal - latest.memAvailable)} / ${bytes(latest.memTotal)}`],
            ['Disk', (latest.diskUsed / latest.diskTotal) * 100, `${bytes(latest.diskUsed)} / ${bytes(latest.diskTotal)}`]] as const).map(([k, v, label]) => (
            <div key={k} className="py-1.5">
              <div className="mb-1 flex justify-between text-xs"><span className="text-fg-3">{k}</span><span className="tnum font-mono">{label}</span></div>
              <Meter value={v} />
            </div>
          ))}
          <Row k="Uptime" mono>{duration(latest.uptime)}</Row>
          <Row k="Processes" mono>{latest.processes}</Row>
          <Row k="Containers" mono>{latest.containers ?? 'Docker unavailable'}</Row>
          <Row k="Active agents" mono>{latest.agents}</Row>
        </Section>
      ) : null}
      {sys ? (
        <Section title="System">
          <Row k="Hostname" mono>{sys.hostname}</Row>
          <Row k="OS">{sys.distro}</Row>
          <Row k="Kernel" mono>{sys.kernel} · {sys.arch}</Row>
          <Row k="CPU">{sys.cpuModel} · {sys.cpuCores} cores</Row>
          <Row k="Memory" mono>{bytes(sys.memTotal)}</Row>
          <Row k="Address" mono>{server.remoteIp ?? '—'}</Row>
          <Row k="Worker" mono>v{sys.workerVersion} as {sys.user}</Row>
        </Section>
      ) : null}
      <Section title="Record">
        <Row k="Last seen">{server.status === 'online' ? 'now' : ago(server.lastSeenAt)}</Row>
        <Row k="Added">{dateTime(server.createdAt)}</Row>
      </Section>
    </>
  );
}

function AgentInspector({ id }: { id: string }) {
  const agent = useAgents().data?.find((a) => a.id === id);
  const server = useServers().data?.find((s) => s.id === agent?.serverId);
  if (!agent) return <div className="p-4 text-sm text-fg-3">This agent is archived or no longer exists.</div>;
  const end = agent.endedAt ? new Date(agent.endedAt).getTime() : Date.now();
  return (
    <>
      <header className="border-b px-4 py-3">
        <h2 className="line-clamp-2 text-[15px] font-medium tracking-tight">{agent.name}</h2>
        <div className="mt-1"><Status status={agent.status} /></div>
        {agent.statusDetail ? <p className="mt-1 text-xs text-fg-3">{agent.statusDetail}</p> : null}
        <div className="mt-3"><Button size="sm" onClick={() => openAgent(agent)}><SquareArrowOutUpRight />Open workspace</Button></div>
      </header>
      <Section title="Run">
        <Row k="Provider">{agent.provider}{agent.model ? ` · ${agent.model}` : ''}</Row>
        <Row k="Server">{server?.name ?? '—'}{agent.serverOnline ? '' : ' (offline)'}</Row>
        <Row k="Directory" mono>{agent.worktreePath ?? agent.cwd}</Row>
        {agent.worktreeBranch ? <Row k="Worktree" mono>{agent.worktreeBranch}</Row> : null}
        <Row k="Permissions">{agent.permissionMode}</Row>
        <Row k="Duration" mono>{agent.startedAt ? duration((end - new Date(agent.startedAt).getTime()) / 1000) : '—'}</Row>
      </Section>
      <Section title="Usage">
        <Row k="Input tokens" mono>{agent.inputTokens.toLocaleString()}</Row>
        <Row k="Output tokens" mono>{agent.outputTokens.toLocaleString()}</Row>
        <Row k="Cost" mono>{agent.costUsd == null ? 'not reported' : usd(agent.costUsd)}</Row>
      </Section>
    </>
  );
}

function BrowserInspector({ id }: { id: string }) {
  const b = useBrowsers().data?.find((x) => x.id === id);
  const server = useServers().data?.find((s) => s.id === b?.serverId);
  if (!b) return <div className="p-4 text-sm text-fg-3">This session no longer exists.</div>;
  return (
    <>
      <header className="border-b px-4 py-3">
        <h2 className="line-clamp-2 text-[15px] font-medium tracking-tight">{b.name}</h2>
        <div className="mt-1"><Status status={b.status} /></div>
        <div className="mt-3"><Button size="sm" onClick={() => openBrowser(b)}><SquareArrowOutUpRight />Open session</Button></div>
      </header>
      <Section title="Session">
        <Row k="Mode">{b.mode === 'agent' ? 'Autonomous' : 'Scripted'}</Row>
        <Row k="Server">{server?.name ?? '—'}</Row>
        <Row k="URL" mono>{b.currentUrl ?? b.startUrl ?? '—'}</Row>
        <Row k="Started">{b.startedAt ? dateTime(b.startedAt) : '—'}</Row>
      </Section>
    </>
  );
}

export function Inspector() {
  const sel = useUi((s) => s.selection);
  return (
    <aside aria-label="Inspector" className="h-full overflow-y-auto bg-panel">
      {!sel ? (
        <EmptyState icon={MousePointerClick} title="Inspector">Select a server, agent, session or file to see its details here.</EmptyState>
      ) : sel.kind === 'server' ? <ServerInspector id={sel.id} />
        : sel.kind === 'agent' ? <AgentInspector id={sel.id} />
        : sel.kind === 'browser' ? <BrowserInspector id={sel.id} />
        : (
          // file / container / process: the selecting view supplies the facts it already has
          <>
            <header className="border-b px-4 py-3"><h2 className="break-all text-[15px] font-medium tracking-tight">{sel.id}</h2><p className="mt-0.5 text-xs capitalize text-fg-3">{sel.kind}</p></header>
            <Section title="Details">
              {Object.entries((sel.data ?? {}) as Record<string, string>).map(([k, v]) => <Row key={k} k={k} mono>{String(v)}</Row>)}
            </Section>
          </>
        )}
    </aside>
  );
}
