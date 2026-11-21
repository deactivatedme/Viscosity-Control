'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, Columns2, LogOut, PanelRight, Search, Settings, ShieldAlert, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Kbd } from '@/components/ui/bits';
import { Menu, MenuItem, MenuSeparator, Tip } from '@/components/ui/menu';
import { api } from '@/lib/api';
import { openLink } from '@/lib/actions';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { useAlerts, useApprovals, useMe } from '@/lib/queries';
import { activeTabset, openTab, shell, workspace } from '@/lib/store';
import type { Alert } from '@/lib/types';
import { events, useTopic } from '@/lib/ws';

const iconBtn = 'relative flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg';

/** Move the selected tab of the active tabset into a new pane on its right. */
export function splitActive() {
  const ws = workspace.current;
  const tabsetId = ws && activeTabset(ws);
  if (!ws || !tabsetId) return;
  type Node = ReturnType<typeof ws.getModel>['root'];
  const find = (n: Node): Extract<Node, { type: 'tabset' }> | undefined => (n.type === 'split' ? n.children.map(find).find(Boolean) : n.id === tabsetId ? n : undefined);
  const tabset = find(ws.getModel().root);
  const tab = tabset?.selectedId ?? tabset?.tabs[0]?.id;
  if (!tabset || !tab) return;
  if (tabset.tabs.length < 2) return void toast('Open a second tab to split the view', { description: 'You can also drag any tab to the edge of the workspace.' });
  ws.moveTab(tab, { region: 'right', tabsetId });
}

export function TopBar() {
  const me = useMe().data;
  const qc = useQueryClient();
  const alerts = useAlerts().data ?? [];
  const approvals = useApprovals().data ?? [];
  const unread = alerts.filter((a) => !a.readAt).length;
  const markRead = useMutation({ mutationFn: () => api('/api/alerts/read', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });

  // Toast new alerts as they arrive (the list itself refetches via useAlerts).
  useTopic<Partial<Alert>>('alerts', (a) => {
    if (!a.title) return;
    const show = a.level === 'error' ? toast.error : a.level === 'warning' ? toast.warning : toast;
    show(a.title, { description: a.body ?? undefined, action: a.link ? { label: 'Open', onClick: () => openLink(a.link!, a.title!) } : undefined });
  });

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    events.close();
    window.location.assign('/login');
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-panel px-2">
      <button onClick={() => shell.openPalette()}
        className="mx-auto flex h-7 w-full max-w-md items-center gap-2 rounded-md border border-line-strong bg-bg px-2.5 text-sm text-fg-3 transition-colors hover:border-fg-4 hover:text-fg-2">
        <Search className="size-3.5" />
        <span className="flex-1 truncate text-left">Search or run a command…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <div className="flex items-center gap-0.5">
        {approvals.length > 0 && (
          <Tip label={`${approvals.length} pending approval${approvals.length > 1 ? 's' : ''}`}>
            <button onClick={() => openTab({ kind: 'activity' }, 'Activity')} className={cn(iconBtn, 'w-auto gap-1.5 px-2 text-fg')}>
              <ShieldAlert className="size-4" strokeWidth={1.6} />
              <span className="tnum font-mono text-xs">{approvals.length}</span>
            </button>
          </Tip>
        )}
        <Menu trigger={
          <button className={iconBtn} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
            <Bell className="size-4" strokeWidth={1.6} />
            {unread > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-fg" />}
          </button>
        }>
          <div className="flex w-80 items-center justify-between px-2 py-1.5">
            <span className="text-xs uppercase tracking-wider text-fg-3">Notifications</span>
            {unread > 0 && <button onClick={() => markRead.mutate()} className="text-xs text-fg-2 hover:text-fg">Mark all read</button>}
          </div>
          <div className="max-h-80 w-80 overflow-y-auto">
            {alerts.length === 0 && <p className="px-2 py-6 text-center text-sm text-fg-3">Nothing yet. Alerts from servers and agents appear here.</p>}
            {alerts.slice(0, 30).map((a) => (
              <button key={a.id} onClick={() => openLink(a.link, a.title)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-active">
                <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', a.readAt ? 'bg-fg-4' : 'bg-fg')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{a.title}</span>
                  {a.body ? <span className="block truncate text-xs text-fg-3">{a.body}</span> : null}
                </span>
                <span className="shrink-0 text-2xs text-fg-3">{ago(a.createdAt)}</span>
              </button>
            ))}
          </div>
        </Menu>
        <Tip label={<>Split view <Kbd>⌘\</Kbd></>}><button onClick={splitActive} className={iconBtn} aria-label="Split view"><Columns2 className="size-4" strokeWidth={1.6} /></button></Tip>
        <Tip label={<>Inspector <Kbd>⌘.</Kbd></>}><button onClick={() => shell.toggleInspector()} className={iconBtn} aria-label="Toggle inspector"><PanelRight className="size-4" strokeWidth={1.6} /></button></Tip>
        <Menu trigger={<button className={iconBtn} aria-label="Account"><UserRound className="size-4" strokeWidth={1.6} /></button>}>
          <div className="px-2 py-1.5">
            <div className="truncate text-sm">{me?.email}</div>
            <div className="text-xs capitalize text-fg-3">{me?.role}{me?.mfaEnabled ? ' · MFA on' : ''}</div>
          </div>
          <MenuSeparator />
          <MenuItem icon={Settings} onSelect={() => openTab({ kind: 'settings' }, 'Settings')}>Settings</MenuItem>
          <MenuItem icon={LogOut} onSelect={logout}>Log out</MenuItem>
        </Menu>
      </div>
    </header>
  );
}
