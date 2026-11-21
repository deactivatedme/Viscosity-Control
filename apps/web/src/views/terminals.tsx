'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, SquareArrowOutUpRight, SquareTerminal, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, SkeletonRows, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Menu, MenuItem } from '@/components/ui/menu';
import { newTerminal, openTerminalTab } from '@/lib/actions';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useServers, useTerminals } from '@/lib/queries';
import { closeTab } from '@/lib/store';
import type { Terminal } from '@/lib/types';

export default function Terminals() {
  const qc = useQueryClient();
  const terminals = useTerminals();
  const servers = useServers().data ?? [];
  const online = servers.filter((s) => s.status === 'online');
  const [closing, setClosing] = useState<Terminal | null>(null);
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? '—';

  const create = online.length === 1
    ? <Button variant="primary" onClick={() => newTerminal(online[0]!)}><Plus />New terminal</Button>
    : (
      <Menu trigger={<Button variant="primary" disabled={online.length === 0}><Plus />New terminal</Button>}>
        {online.map((s) => <MenuItem key={s.id} icon={SquareTerminal} onSelect={() => newTerminal(s)}>{s.name}</MenuItem>)}
      </Menu>
    );

  return (
    <View flush title="Terminals" subtitle={terminals.data ? `${terminals.data.length} open session${terminals.data.length === 1 ? '' : 's'}` : undefined} actions={create}>
      {terminals.isPending ? <SkeletonRows /> : terminals.error ? <ErrorState error={terminals.error} onRetry={() => terminals.refetch()} />
        : terminals.data.length === 0 ? (
          <EmptyState icon={SquareTerminal} title="No open terminals" action={create}>
            {online.length === 0
              ? 'No server is online. Terminals open on an enrolled server whose worker is connected.'
              : "Shells run on the server under the worker's unprivileged service account — never as root unless the server's own config allows it. They keep running if you close this dashboard."}
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-base">
            <thead><tr><Th>Session</Th><Th>Server</Th><Th className="hidden @md:table-cell">Runs as</Th><Th className="hidden @xl:table-cell">Shell</Th><Th>Opened</Th><Th /></tr></thead>
            <tbody>
              {terminals.data.map((t) => (
                <tr key={t.id} tabIndex={0} onDoubleClick={() => openTerminalTab(t)} onKeyDown={(e) => { if (e.key === 'Enter') openTerminalTab(t); }}
                  className="cursor-default transition-colors hover:bg-raised focus-visible:bg-raised">
                  <Td><span className="font-mono text-sm">{t.title}</span></Td>
                  <Td className="text-fg-2">{serverName(t.serverId)}</Td>
                  <Td className="hidden font-mono text-xs text-fg-2 @md:table-cell">{t.runAs ?? '—'}</Td>
                  <Td className="hidden font-mono text-xs text-fg-2 @xl:table-cell">{t.shell ?? '—'}</Td>
                  <Td className="text-sm text-fg-3">{ago(t.createdAt)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1" onDoubleClick={(e) => e.stopPropagation()}>
                      <Button size="sm" onClick={() => openTerminalTab(t)}><SquareArrowOutUpRight />Open</Button>
                      <Button size="icon" variant="ghost" aria-label={`Close ${t.title}`} onClick={() => setClosing(t)}><X /></Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <ConfirmDialog open={!!closing} onOpenChange={() => setClosing(null)} title={`Close ${closing?.title ?? 'terminal'}?`} confirmLabel="Close and kill shell"
        description="This kills the shell and everything still running inside it on the server."
        onConfirm={async () => {
          if (!closing) return;
          await api(`/api/terminals/${closing.id}`, { method: 'DELETE' });
          closeTab({ kind: 'terminal', id: closing.id });
          await qc.invalidateQueries({ queryKey: ['terminals'] });
          toast(`${closing.title} closed`);
        }} />
    </View>
  );
}
