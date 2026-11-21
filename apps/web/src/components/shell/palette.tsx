'use client';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Bot, Columns2, Globe, LogOut, PanelLeft, PanelRight, Plus, Server, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { StatusDot } from '@/components/ui/bits';
import { newTerminal, openAgent, openBrowser, openServer, openWithIntent } from '@/lib/actions';
import { api } from '@/lib/api';
import { useServers } from '@/lib/queries';
import { openTab, shell } from '@/lib/store';
import { events } from '@/lib/ws';
import { NAV } from '@/views';
import { splitActive } from './topbar';

interface SearchResult { servers: { id: string; name: string }[]; agents: { id: string; name: string; status: string }[]; browsers: { id: string; name: string; status: string }[] }

const itemCls = 'flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-fg-2 data-[selected=true]:bg-active data-[selected=true]:text-fg';
const groupCls = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-fg-3';

export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 180); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const servers = useServers().data ?? [];
  const search = useQuery({ queryKey: ['search', debounced], enabled: open && debounced.length >= 2, queryFn: () => api<SearchResult>(`/api/search?q=${encodeURIComponent(debounced)}`) });

  const Item = ({ icon: Icon, children, run, value }: { icon: LucideIcon; children: ReactNode; run: () => void; value: string }) => (
    <Command.Item value={value} className={itemCls} onSelect={() => { onOpenChange(false); run(); }}>
      <Icon className="size-4 shrink-0 text-fg-3" strokeWidth={1.6} />
      {children}
    </Command.Item>
  );

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_24px_80px_rgb(0_0_0/0.6)] animate-in">
      <Command.Input value={q} onValueChange={setQ} placeholder="Search servers, agents, sessions — or run a command"
        className="h-12 w-full border-b bg-transparent px-4 text-[14px] text-fg placeholder:text-fg-4 focus:outline-none" />
      <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-8 text-center text-sm text-fg-3">No matching command or resource.</Command.Empty>

        {search.data && (search.data.servers.length + search.data.agents.length + search.data.browsers.length > 0) ? (
          <Command.Group heading="Results" className={groupCls}>
            {search.data.servers.map((s) => <Item key={s.id} icon={Server} value={`result server ${s.name} ${s.id}`} run={() => openServer(s)}>{s.name}</Item>)}
            {search.data.agents.map((a) => <Item key={a.id} icon={Bot} value={`result agent ${a.name} ${a.id}`} run={() => openAgent(a)}><span className="flex-1 truncate">{a.name}</span><StatusDot status={a.status} /></Item>)}
            {search.data.browsers.map((b) => <Item key={b.id} icon={Globe} value={`result browser ${b.name} ${b.id}`} run={() => openBrowser(b)}><span className="flex-1 truncate">{b.name}</span><StatusDot status={b.status} /></Item>)}
          </Command.Group>
        ) : null}

        <Command.Group heading="Actions" className={groupCls}>
          <Item icon={Plus} value="add server enroll vps" run={() => openWithIntent('servers', 'Servers', 'add-server')}>Add server…</Item>
          <Item icon={Bot} value="new agent claude codex" run={() => openWithIntent('agents', 'Agents', 'new-agent')}>New agent…</Item>
          <Item icon={Globe} value="new browser session playwright" run={() => openWithIntent('browsers', 'Browser Sessions', 'new-browser')}>New browser session…</Item>
          {servers.filter((s) => s.status === 'online').map((s) => (
            <Item key={s.id} icon={SquareTerminal} value={`terminal shell ssh ${s.name}`} run={() => newTerminal(s)}>New terminal on {s.name}</Item>
          ))}
        </Command.Group>

        <Command.Group heading="Go to" className={groupCls}>
          {NAV.map((n) => <Item key={n.kind} icon={n.icon} value={`go ${n.label}`} run={() => openTab({ kind: n.kind }, n.label)}>{n.label}</Item>)}
        </Command.Group>

        <Command.Group heading="Layout" className={groupCls}>
          <Item icon={Columns2} value="split view right" run={splitActive}>Split view</Item>
          <Item icon={PanelLeft} value="toggle sidebar" run={() => shell.toggleSidebar()}>Toggle sidebar</Item>
          <Item icon={PanelRight} value="toggle inspector" run={() => shell.toggleInspector()}>Toggle inspector</Item>
          <Item icon={LogOut} value="log out sign out" run={async () => { await api('/api/auth/logout', { method: 'POST' }); events.close(); window.location.assign('/login'); }}>Log out</Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
