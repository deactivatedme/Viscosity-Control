'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, FolderTree, KeyRound, MoreHorizontal, Pencil, Plus, Server as ServerIcon, ShieldOff, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, Meter, SkeletonRows, Status, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/menu';
import { newTerminal, openFiles, openServer } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, bytes, duration, pct } from '@/lib/format';
import { useMe, useMetrics, useServers } from '@/lib/queries';
import { shell, useUi } from '@/lib/store';
import type { Enrollment, Server } from '@/lib/types';

export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative rounded-lg border border-line-strong bg-bg">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 pr-11 font-mono text-xs leading-relaxed text-fg-2">{text}</pre>
      <button aria-label={label}
        onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md border border-line-strong bg-raised text-fg-2 transition-colors hover:text-fg">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** The enrollment command plus a live view of whether the worker has actually connected. */
export function EnrollmentPanel({ server, enrollment }: { server: Server; enrollment: Enrollment }) {
  const live = useServers().data?.find((s) => s.id === server.id);
  const connected = live?.status === 'online';
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm text-fg-2">Run this on the server as root (Ubuntu or Debian). It installs the worker as a systemd service under an unprivileged account and enrolls it.</p>
        <CopyBlock text={enrollment.command} label="Copy install command" />
        <p className="mt-2 text-xs text-fg-3">The token is single-use and expires {new Date(enrollment.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It is shown only once.</p>
      </div>
      <div className={cn('flex items-center gap-3 rounded-lg border p-3 transition-colors', connected ? 'border-fg-3 bg-raised' : 'border-line-strong')} role="status">
        {connected ? (
          <>
            <span className="flex size-6 items-center justify-center rounded-full bg-fg text-bg"><Check className="size-3.5" strokeWidth={2.5} /></span>
            <div className="min-w-0 text-sm">
              <div>Connected — receiving live metrics</div>
              <div className="truncate font-mono text-xs text-fg-3">{live?.system?.hostname} · {live?.system?.distro} · {live?.system?.cpuCores} cores · {bytes(live?.system?.memTotal)}</div>
            </div>
          </>
        ) : (
          <>
            <span className="size-2 animate-pulse rounded-full border border-fg-2" />
            <span className="text-sm text-fg-2">Waiting for the worker to connect…</span>
          </>
        )}
      </div>
    </div>
  );
}

export function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ server: Server; enrollment: Enrollment } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ server: Server; enrollment: Enrollment }>('/api/servers', { body: { name } }),
    onSuccess: (r) => { setCreated(r); void qc.invalidateQueries({ queryKey: ['servers'] }); },
  });
  const close = (o: boolean) => { if (!o) { setName(''); setCreated(null); create.reset(); } onOpenChange(o); };
  return (
    <Dialog open={open} onOpenChange={close} wide={!!created} title={created ? `Enroll ${created.server.name}` : 'Add server'}
      description={created ? undefined : 'Register a Linux machine. The worker connects outbound over TLS — no inbound ports or SSH keys are needed.'}>
      {created ? (
        <>
          <EnrollmentPanel server={created.server} enrollment={created.enrollment} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)}>Close</Button>
            <Button variant="primary" onClick={() => { openServer(created.server); close(false); }}>Open server</Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Name" hint="how it appears in the dashboard" error={create.error ? errMsg(create.error) : null}>
            <Input autoFocus required maxLength={80} placeholder="e.g. prod-fra-1" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>Create and get install command</Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/** Rename / rotate / revoke / remove — shared by the list and the detail view. */
export function ServerMenu({ server }: { server: Server }) {
  const qc = useQueryClient();
  const admin = useMe().data?.role === 'admin';
  const [dialog, setDialog] = useState<'rename' | 'enroll' | 'revoke' | 'delete' | null>(null);
  const [name, setName] = useState(server.name);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['servers'] });
  const rename = useMutation({ mutationFn: () => api(`/api/servers/${server.id}`, { method: 'PATCH', body: { name } }), onSuccess: () => { void refresh(); setDialog(null); } });
  const enroll = useMutation({ mutationFn: () => api<Enrollment>(`/api/servers/${server.id}/enrollment`, { method: 'POST' }), onSuccess: (e) => { setEnrollment(e); setDialog('enroll'); }, onError: (e) => toast.error(errMsg(e)) });
  if (!admin) return null;
  return (
    <>
      <Menu trigger={<Button variant="ghost" size="icon" aria-label={`Actions for ${server.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button>}>
        <MenuItem icon={Pencil} onSelect={() => { setName(server.name); setDialog('rename'); }}>Rename</MenuItem>
        <MenuItem icon={KeyRound} onSelect={() => enroll.mutate()}>{server.enrolled ? 'Rotate credential (re-enroll)…' : 'New install command…'}</MenuItem>
        <MenuItem icon={ShieldOff} disabled={!server.enrolled} onSelect={() => setDialog('revoke')}>Revoke credential…</MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => setDialog('delete')}>Remove server…</MenuItem>
      </Menu>
      <Dialog open={dialog === 'rename'} onOpenChange={() => setDialog(null)} title="Rename server">
        <form onSubmit={(e) => { e.preventDefault(); rename.mutate(); }}>
          <Field label="Name" error={rename.error ? errMsg(rename.error) : null}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" variant="primary" loading={rename.isPending}>Save</Button></DialogFooter>
        </form>
      </Dialog>
      <Dialog open={dialog === 'enroll' && !!enrollment} onOpenChange={() => setDialog(null)} wide title={`Enroll ${server.name}`}
        description={server.enrolled ? 'Running this replaces the current worker credential; the old one stops working the moment the new one is used.' : undefined}>
        {enrollment ? <EnrollmentPanel server={server} enrollment={enrollment} /> : null}
      </Dialog>
      <ConfirmDialog open={dialog === 'revoke'} onOpenChange={() => setDialog(null)} title={`Revoke ${server.name}'s credential?`} confirmLabel="Revoke"
        description="The worker is disconnected immediately and cannot reconnect until the server is enrolled again. Running agents keep running on the machine but can no longer be observed or controlled."
        onConfirm={async () => { await api(`/api/servers/${server.id}/revoke`, { method: 'POST' }); await refresh(); toast('Credential revoked'); }} />
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={() => setDialog(null)} title={`Remove ${server.name}?`} confirmLabel="Remove server" typeToConfirm={server.name}
        description="This deletes the server record with its agent and browser-session history, and disconnects the worker. Nothing is uninstalled from the machine."
        onConfirm={async () => { await api(`/api/servers/${server.id}`, { method: 'DELETE' }); await refresh(); toast(`${server.name} removed`); }} />
    </>
  );
}

function ServerRow({ server, selected }: { server: Server; selected: boolean }) {
  const online = server.status === 'online';
  const { latest } = useMetrics(server.id, online, server.metrics ? [server.metrics] : undefined);
  const select = useUi((s) => s.select);
  const mem = latest ? (1 - latest.memAvailable / latest.memTotal) * 100 : null;
  const disk = latest ? (latest.diskUsed / latest.diskTotal) * 100 : null;
  const cell = (v: number | null) => v == null
    ? <span className="text-fg-4">—</span>
    : <div className="flex items-center gap-2"><span className="tnum w-9 font-mono text-xs">{pct(v)}</span><Meter value={v} className="w-14" /></div>;
  return (
    <tr tabIndex={0} aria-selected={selected}
      onClick={() => { select({ kind: 'server', id: server.id }); shell.showInspector(); }}
      onDoubleClick={() => openServer(server)}
      onKeyDown={(e) => { if (e.key === 'Enter') openServer(server); }}
      className={cn('cursor-default transition-colors hover:bg-raised focus-visible:bg-raised', selected && 'bg-raised')}>
      <Td>
        <div className="font-medium">{server.name}</div>
        <div className="font-mono text-xs text-fg-3">{server.system?.hostname ?? 'not enrolled yet'}</div>
      </Td>
      <Td><Status status={server.status} />{!online && server.lastSeenAt ? <div className="text-xs text-fg-3">seen {ago(server.lastSeenAt)}</div> : null}</Td>
      <Td className="hidden text-sm text-fg-2 @3xl:table-cell">{server.system ? <>{server.system.distro}<div className="font-mono text-xs text-fg-3">{server.system.cpuCores} cores · {bytes(server.system.memTotal, 0)}</div></> : '—'}</Td>
      <Td>{cell(latest?.cpu ?? null)}</Td>
      <Td className="hidden @xl:table-cell">{cell(mem)}</Td>
      <Td className="hidden @xl:table-cell">{cell(disk)}</Td>
      <Td className="hidden font-mono text-xs text-fg-2 @5xl:table-cell">{latest ? duration(latest.uptime) : '—'}</Td>
      <Td className="text-right">
        <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" disabled={!online} aria-label={`Open terminal on ${server.name}`} onClick={() => newTerminal(server)}><SquareTerminal /></Button>
          <Button variant="ghost" size="icon" disabled={!online} aria-label={`Browse files on ${server.name}`} onClick={() => openFiles(server.id)}><FolderTree /></Button>
          <ServerMenu server={server} />
        </div>
      </Td>
    </tr>
  );
}

export default function Servers() {
  const servers = useServers();
  const admin = useMe().data?.role === 'admin';
  const selection = useUi((s) => s.selection);
  const intent = useUi((s) => s.intent);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (intent === 'add-server') { setAdding(true); useUi.getState().setIntent(null); } }, [intent]);

  const add = admin ? <Button variant="primary" onClick={() => setAdding(true)}><Plus />Add server</Button> : null;
  return (
    <View flush title="Servers" subtitle={servers.data ? `${servers.data.filter((s) => s.status === 'online').length} of ${servers.data.length} online` : undefined} actions={add}>
      {servers.isPending ? <SkeletonRows /> : servers.error ? <ErrorState error={servers.error} onRetry={() => servers.refetch()} />
        : servers.data.length === 0 ? (
          <EmptyState icon={ServerIcon} title="No servers yet" action={add}>
            Enroll your first Linux VPS. A small worker service connects out to this control plane and reports real metrics — nothing here is simulated.
          </EmptyState>
        ) : (
          <table className="w-full border-collapse text-base">
            <thead><tr><Th>Server</Th><Th>Status</Th><Th className="hidden @3xl:table-cell">System</Th><Th>CPU</Th><Th className="hidden @xl:table-cell">Memory</Th><Th className="hidden @xl:table-cell">Disk</Th><Th className="hidden @5xl:table-cell">Uptime</Th><Th /></tr></thead>
            <tbody>{servers.data.map((s) => <ServerRow key={s.id} server={s} selected={selection?.kind === 'server' && selection.id === s.id} />)}</tbody>
          </table>
        )}
      <AddServerDialog open={adding} onOpenChange={setAdding} />
    </View>
  );
}
