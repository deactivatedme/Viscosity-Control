'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronRight, CircleAlert, Info, ScrollText, ShieldCheck, SquareArrowOutUpRight, TriangleAlert } from 'lucide-react';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Badge, EmptyState, ErrorState, Segmented, SkeletonRows, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openLink } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, dateTime } from '@/lib/format';
import { useAlerts, useApprovals, useMe } from '@/lib/queries';
import { openTab } from '@/lib/store';
import type { Approval, AuditEntry } from '@/lib/types';

type Tab = 'approvals' | 'notifications' | 'audit';

function ApprovalCard({ a, canDecide }: { a: Approval; canDecide: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(decision);
    try {
      // workflow gates are keyed by run id + step id
      const base = a.kind === 'workflow' ? `/api/workflows/runs/${a.sessionId}` : `/api/${a.kind === 'agent' ? 'agents' : 'browser'}/${a.sessionId}`;
      await api(`${base}/approvals/${encodeURIComponent(a.approvalId)}`, { body: { decision } });
      await qc.invalidateQueries({ queryKey: ['approvals'] });
    } catch (e) { toast.error(`Could not ${decision} the request`, { description: errMsg(e) }); } finally { setBusy(null); }
  };
  const payload = a.payload?.input === undefined ? null : JSON.stringify(a.payload.input, null, 2);
  return (
    <li className="rounded-lg border border-line-strong bg-panel p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{a.kind}</Badge>
        {a.payload?.tool ? <span className="font-mono text-xs font-medium">{a.payload.tool}</span> : null}
        <span className="ml-auto text-xs text-fg-3">{ago(a.createdAt)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-2">{a.payload?.tool ? null : a.summary}</p>
      {payload ? <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line-strong bg-bg p-2.5 font-mono text-xs leading-relaxed text-fg-2">{payload}</pre> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {canDecide && <Button size="sm" variant="primary" loading={busy === 'allow'} disabled={busy !== null} onClick={() => decide('allow')}>Allow</Button>}
        {canDecide && <Button size="sm" loading={busy === 'deny'} disabled={busy !== null} onClick={() => decide('deny')}>Deny</Button>}
        {a.kind === 'workflow'
          ? <Button size="sm" variant="ghost" onClick={() => openTab({ kind: 'workflows' }, 'Workflows')}><SquareArrowOutUpRight />Open workflows</Button>
          : <Button size="sm" variant="ghost" onClick={() => openLink(`${a.kind}:${a.sessionId}`, a.kind === 'agent' ? 'Agent' : 'Browser session')}><SquareArrowOutUpRight />Open session</Button>}
      </div>
    </li>
  );
}

function Approvals() {
  const approvals = useApprovals();
  const canDecide = useMe().data?.role !== 'viewer';
  if (approvals.isPending) return <SkeletonRows rows={3} />;
  if (approvals.error) return <ErrorState error={approvals.error} onRetry={() => approvals.refetch()} />;
  if (approvals.data.length === 0) return <EmptyState icon={ShieldCheck} title="Nothing is waiting on you">When an agent wants to run a command or a browser session reaches a consequential action, the request appears here.</EmptyState>;
  return <ul className="mx-auto max-w-3xl space-y-3 p-4">{approvals.data.map((a) => <ApprovalCard key={a.id} a={a} canDecide={canDecide} />)}</ul>;
}

const LEVEL = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;

function Notifications() {
  const qc = useQueryClient();
  const alerts = useAlerts();
  const markRead = useMutation({ mutationFn: () => api('/api/alerts/read', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }), onError: (e) => toast.error(errMsg(e)) });
  if (alerts.isPending) return <SkeletonRows />;
  if (alerts.error) return <ErrorState error={alerts.error} onRetry={() => alerts.refetch()} />;
  if (alerts.data.length === 0) return <EmptyState icon={Bell} title="No notifications">Servers going offline, agents finishing or failing, and approval requests are recorded here.</EmptyState>;
  const unread = alerts.data.filter((a) => !a.readAt).length;
  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-fg-3">
        <span>{unread ? `${unread} unread` : 'All read'} · latest {alerts.data.length}</span>
        <Button size="sm" variant="ghost" disabled={!unread} loading={markRead.isPending} onClick={() => markRead.mutate()}>Mark all read</Button>
      </div>
      <ul className="overflow-hidden rounded-lg border border-line-strong">
        {alerts.data.map((a) => {
          const Icon = LEVEL[a.level];
          const body = (
            <>
              <Icon className={cn('mt-0.5 size-4 shrink-0', a.readAt ? 'text-fg-4' : 'text-fg')} strokeWidth={a.level === 'info' ? 1.4 : 2} aria-label={a.level} />
              <span className="min-w-0 flex-1">
                <span className={cn('block break-words text-sm', a.readAt ? 'text-fg-2' : 'font-medium')}>{a.title}</span>
                {a.body ? <span className="block break-words text-xs text-fg-3">{a.body}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-fg-3" title={dateTime(a.createdAt)}>{ago(a.createdAt)}</span>
            </>
          );
          return (
            <li key={a.id} className="border-b last:border-b-0">
              {a.link ? <button onClick={() => openLink(a.link, a.title)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-raised">{body}</button>
                : <div className="flex items-start gap-3 px-3 py-2.5">{body}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Audit() {
  const [limit, setLimit] = useState(200);
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const audit = useQuery({ queryKey: ['audit', limit], queryFn: () => api<AuditEntry[]>(`/api/audit?limit=${limit}`) });
  if (audit.isPending) return <SkeletonRows />;
  if (audit.error) return <ErrorState error={audit.error} onRetry={() => audit.refetch()} />;
  const q = filter.trim().toLowerCase();
  const rows = q ? audit.data.filter((r) => `${r.action} ${r.target ?? ''} ${r.user ?? ''} ${r.ip ?? ''}`.toLowerCase().includes(q)) : audit.data;
  return (
    <div>
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Input aria-label="Filter audit log" placeholder="Filter by action, target, user or IP" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-sm" />
        <span className="tnum text-xs text-fg-3">{rows.length} of {audit.data.length} entries</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => audit.refetch()} loading={audit.isFetching}>Refresh</Button>
      </div>
      {rows.length === 0 ? <EmptyState icon={ScrollText} title="No matching entries">Nothing in the loaded audit entries matches this filter.</EmptyState> : (
        <table className="w-full border-collapse text-base">
          <thead><tr><Th className="w-8" /><Th>Time</Th><Th>Action</Th><Th>Target</Th><Th className="hidden @xl:table-cell">User</Th><Th className="hidden @3xl:table-cell">IP</Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const open = openId === r.id;
              return (
                <Fragment key={r.id}>
                  <tr className="transition-colors hover:bg-raised">
                    <Td className="pr-0">
                      {r.detail != null && (
                        <button aria-label={open ? 'Hide detail' : 'Show detail'} aria-expanded={open} onClick={() => setOpenId(open ? null : r.id)} className="flex size-6 items-center justify-center rounded text-fg-3 hover:bg-active hover:text-fg">
                          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
                        </button>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-xs text-fg-2">{dateTime(r.ts)}</Td>
                    <Td className="font-mono text-xs">{r.action}</Td>
                    <Td className="max-w-72 truncate font-mono text-xs text-fg-2">{r.target ?? '—'}</Td>
                    <Td className="hidden text-sm text-fg-2 @xl:table-cell">{r.user ?? <span className="text-fg-3">worker / system</span>}</Td>
                    <Td className="hidden font-mono text-xs text-fg-3 @3xl:table-cell">{r.ip ?? '—'}</Td>
                  </tr>
                  {open && <tr><td colSpan={6} className="border-b bg-bg px-4 py-2.5"><pre className="overflow-auto font-mono text-xs leading-relaxed text-fg-2">{JSON.stringify(r.detail, null, 2)}</pre></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {audit.data.length >= limit && limit < 500 && <div className="p-3 text-center"><Button size="sm" variant="ghost" onClick={() => setLimit(500)}>Load up to 500</Button></div>}
    </div>
  );
}

export default function Activity() {
  const admin = useMe().data?.role === 'admin';
  const pending = useApprovals().data?.length ?? 0;
  const [tab, setTab] = useState<Tab>('approvals');
  const options: { value: Tab; label: React.ReactNode }[] = [
    { value: 'approvals', label: <>Approvals{pending ? <span className="tnum ml-1.5 font-mono text-2xs">{pending}</span> : null}</> },
    { value: 'notifications', label: 'Notifications' },
    ...(admin ? [{ value: 'audit' as const, label: 'Audit log' }] : []),
  ];
  return (
    <View flush title="Activity" subtitle="Approvals, notifications and the audit trail" actions={<Segmented value={tab} onChange={setTab} options={options} />}>
      {tab === 'approvals' ? <Approvals /> : tab === 'notifications' ? <Notifications /> : <Audit />}
    </View>
  );
}
