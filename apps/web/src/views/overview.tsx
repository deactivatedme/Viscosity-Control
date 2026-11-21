'use client';
import { ArrowRight, Bot, Check, Globe, KeyRound, Server as ServerIcon, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Meter, Skeleton, Sparkline, Status, StatusDot, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import { openAgent, openLink, openServer, openWithIntent } from '@/lib/actions';
import { cn } from '@/lib/cn';
import { ago, bytes, pct } from '@/lib/format';
import { useAgents, useAlerts, useApprovals, useBrowsers, useCredentials, useMe, useMetrics, useServers } from '@/lib/queries';
import { openTab } from '@/lib/store';
import type { Server } from '@/lib/types';

const ACTIVE = ['queued', 'starting', 'running', 'waiting_approval'];

function Tile({ label, value, sub, onClick }: { label: string; value: ReactNode; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group rounded-xl border bg-panel p-4 text-left transition-colors hover:border-line-strong hover:bg-raised">
      <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-fg-3">{label}<ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" /></div>
      <div className="tnum mt-2 font-mono text-2xl tracking-tight">{value}</div>
      <div className="mt-0.5 text-xs text-fg-3">{sub}</div>
    </button>
  );
}

function ServerCard({ server }: { server: Server }) {
  const online = server.status === 'online';
  const { history, latest } = useMetrics(server.id, online, server.metrics ? [server.metrics] : undefined);
  const mem = latest ? (1 - latest.memAvailable / latest.memTotal) * 100 : 0;
  return (
    <button onClick={() => openServer(server)} className="rounded-xl border bg-panel p-4 text-left transition-colors hover:border-line-strong hover:bg-raised">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{server.name}</div>
          <div className="truncate font-mono text-xs text-fg-3">{server.system?.hostname ?? 'not enrolled'}</div>
        </div>
        <Status status={server.status} className="shrink-0" />
      </div>
      {online && latest ? (
        <>
          <div className="mt-3 flex items-end justify-between gap-3">
            <div><div className="text-xs text-fg-3">CPU</div><div className="tnum font-mono text-lg">{pct(latest.cpu)}</div></div>
            <Sparkline values={history.map((m) => m.cpu)} max={100} className="h-9 max-w-[60%] text-fg-2" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div><div className="mb-1 flex justify-between text-fg-3"><span>Memory</span><span className="tnum font-mono text-fg-2">{pct(mem)}</span></div><Meter value={mem} /></div>
            <div><div className="mb-1 flex justify-between text-fg-3"><span>Disk</span><span className="tnum font-mono text-fg-2">{bytes(latest.diskUsed, 0)}</span></div><Meter value={(latest.diskUsed / latest.diskTotal) * 100} /></div>
          </div>
        </>
      ) : (
        <p className="mt-3 text-xs text-fg-3">{server.status === 'pending' ? 'Waiting for the worker to be installed.' : `No live data — last seen ${ago(server.lastSeenAt)}.`}</p>
      )}
    </button>
  );
}

/** First-run guidance derived from real state; disappears once every step is genuinely done. */
function GettingStarted({ steps }: { steps: { done: boolean; title: string; body: string; action?: ReactNode }[] }) {
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="vc-field overflow-hidden rounded-xl border border-line-strong">
      <div className="bg-bg/70 p-5 backdrop-blur-[1px] @md:p-6">
        <div className="flex items-center gap-3"><Logo className="size-5" /><h2 className="text-[15px] font-medium tracking-tight">Getting started</h2><span className="font-mono text-xs text-fg-3">{steps.filter((s) => s.done).length}/{steps.length}</span></div>
        <ol className="mt-4 grid gap-2.5 @xl:grid-cols-2 @5xl:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.title} className={cn('rounded-lg border p-3.5 transition-colors', i === next ? 'border-fg-3 bg-raised' : 'border-line bg-panel/80')}>
              <div className="flex items-center gap-2">
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-2xs', s.done ? 'border-fg bg-fg text-bg' : 'border-line-strong text-fg-3')}>
                  {s.done ? <Check className="size-3" strokeWidth={2.5} /> : i + 1}
                </span>
                <span className={cn('text-sm font-medium', s.done && 'text-fg-2')}>{s.title}</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-fg-3">{s.body}</p>
              {!s.done && i === next && s.action ? <div className="mt-3">{s.action}</div> : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export default function Overview() {
  const admin = useMe().data?.role === 'admin';
  const servers = useServers();
  const agents = useAgents().data ?? [];
  const browsers = useBrowsers().data ?? [];
  const approvals = useApprovals().data ?? [];
  const alerts = useAlerts().data ?? [];
  const creds = useCredentials().data;
  const list = servers.data ?? [];
  const online = list.filter((s) => s.status === 'online').length;
  const activeAgents = agents.filter((a) => ACTIVE.includes(a.status));
  const activeBrowsers = browsers.filter((b) => ACTIVE.includes(b.status));

  const steps = [
    { done: true, title: 'Create the administrator', body: 'Your account is the only one that can enroll servers and store provider keys.' },
    { done: list.some((s) => s.enrolled), title: 'Enroll a server', body: 'Install the worker on a Linux VPS with one command. It connects outbound and starts reporting real metrics.',
      action: admin ? <Button size="sm" variant="primary" onClick={() => openWithIntent('servers', 'Servers', 'add-server')}><ServerIcon />Add server</Button> : undefined },
    { done: (creds?.length ?? 0) > 0, title: 'Connect an AI provider', body: 'Store an Anthropic or OpenAI API key, encrypted at rest. Or skip this if the worker already has provider credentials in its environment.',
      action: <Button size="sm" variant="primary" onClick={() => openTab({ kind: 'settings' }, 'Settings')}><KeyRound />Open settings</Button> },
    { done: agents.length > 0, title: 'Launch an agent', body: 'Pick a server and a directory, describe the task, and watch the agent work in real time.',
      action: <Button size="sm" variant="primary" onClick={() => openWithIntent('agents', 'Agents', 'new-agent')}><Bot />New agent</Button> },
  ];
  const onboarding = servers.isSuccess && creds !== undefined && steps.some((s) => !s.done);

  return (
    <View title="Overview" subtitle="Everything connected to this control plane, live.">
      <div className="mx-auto max-w-6xl space-y-5">
        {onboarding ? <GettingStarted steps={steps} /> : null}

        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
          <Tile label="Servers" value={servers.isPending ? <Skeleton className="h-8 w-16" /> : <>{online}<span className="text-fg-3">/{list.length}</span></>} sub="online" onClick={() => openTab({ kind: 'servers' }, 'Servers')} />
          <Tile label="Agents" value={activeAgents.length} sub={`running · ${agents.length} total`} onClick={() => openTab({ kind: 'agents' }, 'Agents')} />
          <Tile label="Browser sessions" value={activeBrowsers.length} sub={`running · ${browsers.length} total`} onClick={() => openTab({ kind: 'browsers' }, 'Browser Sessions')} />
          <Tile label="Approvals" value={approvals.length} sub={approvals.length ? 'waiting for you' : 'nothing pending'} onClick={() => openTab({ kind: 'activity' }, 'Activity')} />
        </div>

        {list.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs uppercase tracking-[0.14em] text-fg-3">Servers</h2>
            <div className="grid gap-3 @md:grid-cols-2 @5xl:grid-cols-3">{list.map((s) => <ServerCard key={s.id} server={s} />)}</div>
          </section>
        )}

        <div className="grid gap-5 @3xl:grid-cols-2">
          <section className="rounded-xl border bg-panel">
            <h2 className="flex items-center gap-2 border-b px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-fg-3"><Bot className="size-3.5" />Working now</h2>
            {activeAgents.length + activeBrowsers.length === 0 ? <p className="px-4 py-8 text-center text-sm text-fg-3">No agents or browser sessions are running.</p> : (
              <ul className="divide-y">
                {activeAgents.slice(0, 6).map((a) => (
                  <li key={a.id}><button onClick={() => openAgent(a)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised">
                    <StatusDot status={a.status} /><span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                    {a.status === 'waiting_approval' ? <ShieldAlert className="size-3.5" /> : null}
                    <span className="font-mono text-xs text-fg-3">{a.provider}</span>
                  </button></li>
                ))}
                {activeBrowsers.slice(0, 4).map((b) => (
                  <li key={b.id}><button onClick={() => openLink(`browser:${b.id}`, b.name)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised">
                    <StatusDot status={b.status} /><span className="min-w-0 flex-1 truncate text-sm">{b.name}</span><Globe className="size-3.5 text-fg-3" />
                  </button></li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-xl border bg-panel">
            <h2 className="border-b px-4 py-2.5 text-xs uppercase tracking-[0.14em] text-fg-3">Recent activity</h2>
            {alerts.length === 0 ? <p className="px-4 py-8 text-center text-sm text-fg-3">Server and agent events will appear here.</p> : (
              <ul className="divide-y">
                {alerts.slice(0, 8).map((a) => (
                  <li key={a.id}><button onClick={() => openLink(a.link, a.title)} className="flex w-full items-baseline gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised">
                    <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span><span className="shrink-0 text-xs text-fg-3">{ago(a.createdAt)}</span>
                  </button></li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </View>
  );
}
