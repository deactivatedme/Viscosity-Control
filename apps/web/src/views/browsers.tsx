'use client';
import { Globe, Plus, SquareArrowOutUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NewBrowserDialog } from '@/components/browser/new-session';
import { Badge, EmptyState, ErrorState, SkeletonRows, Status, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { openBrowser } from '@/lib/actions';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { useBrowsers, useMe, useServers } from '@/lib/queries';
import { shell, useUi } from '@/lib/store';

const ACTIVE = ['queued', 'starting', 'running', 'waiting_approval'];

export default function Browsers() {
  const sessions = useBrowsers();
  const servers = useServers().data ?? [];
  const canRun = useMe().data?.role !== 'viewer';
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const intent = useUi((s) => s.intent);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (intent === 'new-browser') { setCreating(true); useUi.getState().setIntent(null); } }, [intent]);

  const add = canRun ? <Button variant="primary" onClick={() => setCreating(true)}><Plus />New browser session</Button> : null;
  const active = sessions.data?.filter((s) => ACTIVE.includes(s.status)).length ?? 0;
  return (
    <View flush title="Browser Sessions" subtitle={sessions.data ? `${active} active · ${sessions.data.length} total` : undefined} actions={add}>
      {sessions.isPending ? <SkeletonRows /> : sessions.error ? <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
        : sessions.data.length === 0 ? (
          <EmptyState icon={Globe} title="No browser sessions yet" action={add}>
            Run a scripted or autonomous task in an isolated Chromium on one of your servers, and watch every action and screenshot as it happens.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-base">
            <thead><tr><Th>Session</Th><Th>Status</Th><Th className="hidden md:table-cell">Server</Th><Th className="hidden lg:table-cell">Current URL</Th><Th className="hidden sm:table-cell">Started</Th><Th /></tr></thead>
            <tbody>
              {sessions.data.map((s) => {
                const selected = selection?.kind === 'browser' && selection.id === s.id;
                return (
                  <tr key={s.id} tabIndex={0} aria-selected={selected}
                    onClick={() => { select({ kind: 'browser', id: s.id }); shell.showInspector(); }}
                    onDoubleClick={() => openBrowser(s)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openBrowser(s); }}
                    className={cn('cursor-default transition-colors hover:bg-raised focus-visible:bg-raised', selected && 'bg-raised')}>
                    <Td>
                      <div className="flex items-center gap-2"><span className="max-w-72 truncate font-medium">{s.name}</span><Badge>{s.mode === 'agent' ? 'auto' : 'script'}</Badge></div>
                    </Td>
                    <Td><Status status={s.status} /></Td>
                    <Td className="hidden text-sm text-fg-2 md:table-cell">{servers.find((x) => x.id === s.serverId)?.name ?? '—'}{s.serverOnline ? '' : <span className="text-fg-3"> · offline</span>}</Td>
                    <Td className="hidden lg:table-cell"><span className="block max-w-80 truncate font-mono text-xs text-fg-2">{s.currentUrl ?? s.startUrl ?? '—'}</span></Td>
                    <Td className="hidden text-sm text-fg-3 sm:table-cell">{s.startedAt ? ago(s.startedAt) : '—'}</Td>
                    <Td className="text-right">
                      <Button variant="ghost" size="icon" aria-label={`Open ${s.name}`} onClick={(e) => { e.stopPropagation(); openBrowser(s); }}><SquareArrowOutUpRight /></Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      <NewBrowserDialog open={creating} onOpenChange={setCreating} />
    </View>
  );
}
