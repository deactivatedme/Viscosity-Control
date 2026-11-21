'use client';
import { cn } from '@/lib/cn';
import { useAgents, useServers } from '@/lib/queries';
import { useConnection } from '@/lib/ws';

export function StatusBar() {
  const conn = useConnection((s) => s.state);
  const servers = useServers().data ?? [];
  const agents = useAgents().data ?? [];
  const online = servers.filter((s) => s.status === 'online').length;
  const running = agents.filter((a) => ['starting', 'running', 'waiting_approval'].includes(a.status)).length;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-panel px-3 font-mono text-2xs text-fg-3">
      <span className="flex items-center gap-1.5" role="status">
        <span className={cn('size-1.5 rounded-full', conn === 'open' ? 'bg-fg' : 'border border-fg-3')} />
        {conn === 'open' ? 'live' : conn === 'connecting' ? 'connecting…' : 'reconnecting…'}
      </span>
      <span className="tnum">{online}/{servers.length} servers online</span>
      <span className="tnum">{running} agent{running === 1 ? '' : 's'} running</span>
      <span className="ml-auto hidden sm:block">⌘K commands · ⌘B sidebar · ⌘. inspector · ⌘\ split</span>
    </footer>
  );
}
