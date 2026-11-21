'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Boxes, History, KeyRound, RefreshCw, Rocket, ScrollText, Settings2, ShieldAlert, Square, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { HttpCheck } from '@viscosity/protocol';
import { DeployStatus, EnvBadge, shortSha } from '@/components/deployments/bits';
import { EnvEditor } from '@/components/deployments/env-editor';
import { DeploymentDialog } from '@/components/deployments/form';
import type { DeploymentDetail, Release } from '@/components/deployments/types';
import { ErrorState, SkeletonRows, StatusDot, Td, Th, View } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { openAgent } from '@/lib/actions';
import { api, errMsg } from '@/lib/api';
import { ago, dateTime } from '@/lib/format';
import { useMe, useServers } from '@/lib/queries';
import { closeTab, renameTab } from '@/lib/store';
import { useTopic } from '@/lib/ws';

function Card({ icon: Icon, title, actions, children }: { icon: typeof Boxes; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-panel">
      <header className="flex min-h-10 items-center justify-between gap-2 border-b px-4 py-1.5">
        <h2 className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-fg-3"><Icon className="size-3.5" strokeWidth={1.6} />{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

function LogsDialog({ serverId, container, onClose }: { serverId: string; container: { id: string; name: string } | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['container-logs', container?.id], enabled: !!container, queryFn: () => api<{ text: string }>(`/api/servers/${serverId}/containers/${container!.id}/logs?tail=300`) });
  return (
    <Dialog open={!!container} onOpenChange={onClose} wide title={`Logs · ${container?.name ?? ''}`} description="Last 300 lines from the container.">
      {q.isPending ? <SkeletonRows rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-bg p-3 font-mono text-xs leading-relaxed text-fg-2">{q.data.text || 'The container has not written any output.'}</pre>}
      <DialogFooter><Button onClick={() => q.refetch()} loading={q.isFetching}><RefreshCw />Refresh</Button></DialogFooter>
    </Dialog>
  );
}

export default function DeploymentView({ id }: { id?: string }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const servers = useServers().data ?? [];
  const q = useQuery({ queryKey: ['deployment', id], enabled: !!id, queryFn: () => api<DeploymentDetail>(`/api/deployments/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['deployment', id] });
  useTopic<{ id?: string }>('deployments', (e) => { if (!e.id || e.id === id) void refresh(); });
  const d = q.data;
  const busy = d?.status === 'deploying';
  // containers change while a deploy runs; keep them fresh without a manual reload
  useEffect(() => { if (!busy) return; const t = setInterval(() => void refresh(), 2500); return () => clearInterval(t); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (d && id) renameTab({ kind: 'deployment', id }, d.name); }, [d?.name, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [deploying, setDeploying] = useState(false);
  const [version, setVersion] = useState('');
  const [typed, setTyped] = useState('');
  const [rollback, setRollback] = useState<Release | null>(null);
  const [dialog, setDialog] = useState<'stop' | 'delete' | 'settings' | null>(null);
  const [logs, setLogs] = useState<{ id: string; name: string } | null>(null);
  const [health, setHealth] = useState<HttpCheck | null>(null);

  const deploy = useMutation({
    mutationFn: () => api<Release>(`/api/deployments/${id}/deploy`, { body: { version: version.trim() || null } }),
    onSuccess: (r) => { setDeploying(false); setVersion(''); setTyped(''); void refresh(); toast(r.status === 'pending_approval' ? 'Deployment requested — waiting for an administrator' : 'Deployment started'); },
  });
  const decide = useMutation({
    mutationFn: (v: { rid: string; action: 'approve' | 'reject' }) => api(`/api/deployments/${id}/releases/${v.rid}/${v.action}`, { method: 'POST' }),
    onSuccess: (_r, v) => { void refresh(); toast(v.action === 'approve' ? 'Approved — deploying' : 'Request rejected'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const check = useMutation({
    mutationFn: () => api<HttpCheck>(`/api/deployments/${id}/health`),
    onSuccess: (h) => { setHealth(h); void refresh(); },
    onError: (e) => toast.error('Health check could not run', { description: errMsg(e) }),
  });

  if (q.isPending) return <SkeletonRows rows={8} />;
  if (q.error || !d) return <ErrorState error={q.error ?? new Error('deployment not found')} onRetry={() => q.refetch()} />;

  const server = servers.find((s) => s.id === d.serverId);
  const admin = me?.role === 'admin';
  const production = d.environment === 'production';
  const canOperate = me?.role !== 'viewer';
  const canChange = canOperate && (!production || admin); // settings, env, stop, delete
  const pending = d.releases.find((r) => r.status === 'pending_approval');
  const current = d.releases.find((r) => r.id === d.currentReleaseId);
  const needsTyping = production && typed !== d.name;

  return (
    <View
      title={<span className="flex flex-wrap items-center gap-x-3 gap-y-1">{d.name}<EnvBadge environment={d.environment} /><DeployStatus status={d.status} /></span>}
      subtitle={<>on {server?.name ?? 'unknown server'} · <span className="font-mono">{d.workdir}/{d.composeFile}</span> · project <span className="font-mono">{d.composeProject}</span></>}
      actions={canOperate ? <>
        <Button variant="primary" disabled={busy || !d.serverOnline || !!pending} onClick={() => setDeploying(true)}><Rocket />{production && !admin ? 'Request deployment' : 'Deploy'}</Button>
        {canChange ? <>
          <Button disabled={busy || !d.serverOnline} onClick={() => setDialog('stop')}><Square />Stop</Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Deployment settings" onClick={() => setDialog('settings')}><Settings2 /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Delete deployment" disabled={busy} onClick={() => setDialog('delete')}><Trash2 /></Button>
        </> : null}
      </> : null}>
      <div className="mx-auto max-w-6xl space-y-4">
        {!d.serverOnline && (
          <div role="status" className="rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-sm text-fg-2">
            {server?.name ?? 'The server'} is offline. What you see is the last known state; deploys, health checks and container listings need the worker to reconnect.
          </div>
        )}
        {pending && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-fg-3 bg-raised px-4 py-3">
            <ShieldAlert className="size-4 shrink-0" strokeWidth={1.6} />
            <div className="min-w-0 flex-1 text-sm">
              <div>Production {pending.trigger === 'rollback' ? 'rollback' : 'deployment'} requested by {pending.requestedBy ?? 'someone'} {ago(pending.createdAt)}{pending.version ? <> · version <span className="font-mono">{shortSha(pending.version)}</span></> : null}</div>
              <div className="text-xs text-fg-3">{admin ? 'Nothing runs until you approve it.' : 'Waiting for an administrator to approve it.'}</div>
            </div>
            {admin && <>
              <Button onClick={() => decide.mutate({ rid: pending.id, action: 'reject' })} disabled={decide.isPending}>Reject</Button>
              <Button variant="primary" onClick={() => decide.mutate({ rid: pending.id, action: 'approve' })} loading={decide.isPending} disabled={!d.serverOnline}>Approve and deploy</Button>
            </>}
          </div>
        )}

        <div className="grid gap-4 @3xl:grid-cols-2">
          <Card icon={Boxes} title="Containers" actions={<Button size="icon" variant="ghost" aria-label="Refresh containers" onClick={() => refresh()}><RefreshCw className={q.isFetching ? 'animate-spin' : ''} /></Button>}>
            {d.containersError ? <p className="px-4 py-3 text-sm text-fg-2">Containers could not be listed: <span className="font-mono text-xs">{d.containersError}</span></p>
              : d.containers.length === 0 ? <p className="px-4 py-6 text-center text-sm text-fg-3">Nothing is running for this project. Deploy it to start its containers.</p> : (
                <ul className="divide-y">
                  {d.containers.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                      <div className="min-w-40 flex-1">
                        <div className="truncate font-mono text-xs">{c.name}</div>
                        <div className="truncate text-xs text-fg-3">{c.image} · {c.status}{c.ports ? ` · ${c.ports}` : ''}</div>
                      </div>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm capitalize text-fg-2"><StatusDot status={c.state === 'running' ? 'online' : c.state} />{c.state}</span>
                      {c.health ? <span className="font-mono text-2xs uppercase text-fg-3">{c.health}</span> : null}
                      <Button size="sm" variant="ghost" onClick={() => setLogs({ id: c.id, name: c.name })}><ScrollText />Logs</Button>
                    </li>
                  ))}
                </ul>
              )}
          </Card>

          <Card icon={Activity} title="Health" actions={d.healthUrl ? <Button size="sm" loading={check.isPending} disabled={!d.serverOnline} onClick={() => check.mutate()}>Check health now</Button> : null}>
            {d.healthUrl ? (
              <dl className="space-y-1.5 px-4 py-3 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-fg-3">URL</dt><dd className="min-w-0 truncate font-mono text-xs">{d.healthUrl}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-fg-3">Last deploy</dt><dd className="text-right">{current?.health ? (current.health.ok ? `HTTP ${current.health.status} in ${current.health.ms} ms` : `failed: ${current.health.error ?? `HTTP ${current.health.status}`}`) : 'not checked'}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-fg-3">Checked now</dt><dd className="text-right">{health ? (health.ok ? `HTTP ${health.status} in ${health.ms} ms` : `failed: ${health.error ?? `HTTP ${health.status}`}`) : '—'}</dd></div>
                <p className="pt-1 text-xs text-fg-3">The request is made from the server itself, so it can reach services bound to localhost. It is repeated every minute.</p>
              </dl>
            ) : <p className="px-4 py-6 text-center text-sm text-fg-3">No health URL is configured, so a deploy only confirms that the containers started. Add one in settings.</p>}
          </Card>
        </div>

        <Card icon={KeyRound} title="Environment variables" actions={<span className="hidden text-xs text-fg-3 @md:inline">encrypted · write-only · applied on deploy</span>}>
          <EnvEditor deployment={d} canEdit={!!canChange} />
        </Card>

        <Card icon={History} title="Releases">
          {d.releases.length === 0 ? <p className="px-4 py-6 text-center text-sm text-fg-3">Not deployed yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead><tr><Th>Version</Th><Th>Status</Th><Th className="hidden @xl:table-cell">By</Th><Th>When</Th><Th className="hidden @3xl:table-cell">Detail</Th><Th /></tr></thead>
                <tbody>
                  {d.releases.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-raised">
                      <Td><span className="font-mono text-xs">{shortSha(r.version)}</span>{r.id === d.currentReleaseId ? <span className="ml-2 rounded border border-line-strong px-1 font-mono text-2xs uppercase text-fg-3">current</span> : null}
                        {r.trigger === 'rollback' ? <div className="text-xs text-fg-3">rollback</div> : null}</Td>
                      <Td><DeployStatus status={r.status} /></Td>
                      <Td className="hidden text-xs text-fg-2 @xl:table-cell">{r.requestedBy ?? '—'}{r.approvedBy && r.approvedBy !== r.requestedBy ? <div className="text-fg-3">{r.status === 'rejected' ? 'rejected' : 'approved'} by {r.approvedBy}</div> : null}</Td>
                      <Td className="whitespace-nowrap text-xs text-fg-2" ><span title={dateTime(r.createdAt)}>{ago(r.createdAt)}</span></Td>
                      <Td className="hidden max-w-0 w-full @3xl:table-cell"><div className="truncate text-xs text-fg-3" title={r.detail ?? ''}>{r.detail}</div></Td>
                      <Td className="py-1 text-right">
                        <div className="flex justify-end gap-1">
                          {r.sessionId ? <Button size="sm" variant="ghost" onClick={() => openAgent({ id: r.sessionId!, name: `Deploy · ${d.name}` })}><ScrollText />View log</Button> : null}
                          {canOperate && r.version && r.status === 'succeeded' && r.id !== d.currentReleaseId
                            ? <Button size="sm" variant="ghost" disabled={busy || !!pending} onClick={() => setRollback(r)}><Undo2 />Roll back to this</Button> : null}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.releases.some((r) => r.status === 'failed' && r.detail) && d.status !== 'healthy' ? (
            <p className="border-t px-4 py-2.5 font-mono text-xs leading-relaxed text-fg-2">{d.releases.find((r) => r.status === 'failed')?.detail}</p>
          ) : null}
        </Card>
      </div>

      <Dialog open={deploying} onOpenChange={(o) => { setDeploying(o); if (!o) deploy.reset(); }} title={production && !admin ? `Request deployment of ${d.name}` : `Deploy ${d.name}`}
        description={production && !admin ? 'Production deployments need an administrator. This creates a request; nothing runs until it is approved.'
          : <>Runs <span className="font-mono">docker compose up -d --build</span> in <span className="font-mono">{d.workdir}</span> on {server?.name}{d.healthUrl ? ', then checks health' : ''}.</>}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); deploy.mutate(); }}>
          <Field label="Version" hint="optional · branch, tag or commit">
            <Input className="font-mono" placeholder="leave empty to deploy what is checked out now" value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
          {production && (
            <div className="space-y-1.5">
              <p className="text-sm text-fg-2">This is <span className="text-fg">production</span>. Type <span className="font-mono text-fg">{d.name}</span> to confirm.</p>
              <Input aria-label="Confirmation text" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          {deploy.error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(deploy.error)}</p> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeploying(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={deploy.isPending} disabled={needsTyping}>{production && !admin ? 'Request deployment' : 'Deploy now'}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog open={!!rollback} onOpenChange={() => setRollback(null)} title={`Roll back to ${shortSha(rollback?.version)}?`} confirmLabel={production && !admin ? 'Request rollback' : 'Roll back'}
        typeToConfirm={production ? d.name : undefined}
        description={<>Checks out <span className="font-mono">{shortSha(rollback?.version)}</span> in the working directory and redeploys it. The directory stays on that commit until you deploy a branch again.</>}
        onConfirm={async () => { await api(`/api/deployments/${d.id}/rollback`, { body: { releaseId: rollback!.id } }); await refresh(); toast('Rollback started'); }} />
      <ConfirmDialog open={dialog === 'stop'} onOpenChange={() => setDialog(null)} title={`Stop ${d.name}?`} confirmLabel="Stop containers" typeToConfirm={production ? d.name : undefined}
        description="Stops the project's containers without removing them. The application will be unavailable until it is deployed again."
        onConfirm={async () => { await api(`/api/deployments/${d.id}/stop`, { method: 'POST' }); await refresh(); toast(`${d.name} stopped`); }} />
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={() => setDialog(null)} title={`Delete ${d.name}?`} confirmLabel={d.serverOnline ? 'Remove and delete' : 'Delete record'} typeToConfirm={d.name}
        description={d.serverOnline
          ? <>Runs <span className="font-mono">docker compose down</span> to remove this project&apos;s containers and networks, then deletes the deployment and its release history. Files in the working directory and named volumes are kept.</>
          : <>The server is offline, so its containers cannot be removed from here: only this record and its release history are deleted. Run <span className="font-mono">docker compose -p {d.composeProject} down</span> on the server later.</>}
        onConfirm={async () => { await api(`/api/deployments/${d.id}?down=${d.serverOnline ? 1 : 0}`, { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['deployments'] }); toast(`${d.name} deleted`); closeTab({ kind: 'deployment', id: d.id }); }} />
      <DeploymentDialog open={dialog === 'settings'} onOpenChange={() => setDialog(null)} editing={d} />
      <LogsDialog serverId={d.serverId} container={logs} onClose={() => setLogs(null)} />
    </View>
  );
}
