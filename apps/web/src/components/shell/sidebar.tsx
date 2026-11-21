'use client';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Logo, Wordmark } from '@/components/ui/logo';
import { Tip } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { useAgents, useApprovals, useServers } from '@/lib/queries';
import { openTab, selectedKinds, shell, useUi } from '@/lib/store';
import { NAV } from '@/views';

export function Sidebar({ narrow }: { narrow: boolean }) {
  const model = useUi((s) => s.model);
  const active = selectedKinds(model);
  const servers = useServers().data;
  const agents = useAgents().data;
  const approvals = useApprovals().data;
  // Small live counters next to the sections they describe.
  const counts: Record<string, number | undefined> = {
    servers: servers?.filter((s) => s.status === 'online').length || undefined,
    agents: agents?.filter((a) => ['starting', 'running', 'waiting_approval', 'queued'].includes(a.status)).length || undefined,
    activity: approvals?.length || undefined,
  };
  const related: Record<string, string> = { server: 'servers', agent: 'agents', browser: 'browsers', terminal: 'terminals' };
  const isActive = (kind: string) => active.has(kind) || [...active].some((k) => related[k] === kind);

  return (
    <nav aria-label="Primary" className="flex h-full flex-col bg-panel">
      <div className={cn('flex h-11 shrink-0 items-center border-b', narrow ? 'justify-center' : 'gap-2.5 px-3.5')}>
        <Logo className="size-5 shrink-0" />
        {!narrow && <Wordmark className="truncate text-sm" />}
      </div>
      <ul className="flex-1 space-y-px overflow-y-auto p-1.5">
        {NAV.map(({ kind, label, icon: Icon }) => {
          const item = (
            <button
              onClick={() => openTab({ kind }, label)}
              aria-label={label}
              aria-current={isActive(kind) ? 'page' : undefined}
              className={cn(
                'group flex h-8 w-full items-center rounded-md text-sm transition-colors duration-150',
                narrow ? 'justify-center' : 'gap-2.5 px-2.5',
                isActive(kind) ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.6} />
              {!narrow && <span className="flex-1 truncate text-left">{label}</span>}
              {!narrow && counts[kind] ? <span className="tnum font-mono text-2xs text-fg-3">{counts[kind]}</span> : null}
            </button>
          );
          return <li key={kind}>{narrow ? <Tip label={label} side="right">{item}</Tip> : item}</li>;
        })}
      </ul>
      <div className="border-t p-1.5">
        <Tip label={narrow ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
          <button onClick={() => shell.toggleSidebar()} aria-label="Toggle sidebar"
            className={cn('flex h-8 w-full items-center rounded-md text-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg', narrow ? 'justify-center' : 'gap-2.5 px-2.5')}>
            {narrow ? <PanelLeftOpen className="size-4" strokeWidth={1.6} /> : <PanelLeftClose className="size-4" strokeWidth={1.6} />}
            {!narrow && <span>Collapse</span>}
          </button>
        </Tip>
      </div>
    </nav>
  );
}
