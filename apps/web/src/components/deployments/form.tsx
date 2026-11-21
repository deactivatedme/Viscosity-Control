'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Segmented } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import { useMe, useServers } from '@/lib/queries';
import type { Deployment } from './types';

interface ProjectOption { id: string; name: string; serverId: string; path: string }

/** Create a deployment, or (with `editing`) change its settings. Environment variables are edited separately once it exists. */
export function DeploymentDialog({ open, onOpenChange, editing, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; editing?: Deployment; onSaved?: (d: Deployment) => void }) {
  const qc = useQueryClient();
  const admin = useMe().data?.role === 'admin';
  const servers = useServers().data ?? [];
  // Projects are optional context; the list may be empty (or the feature absent) and that is fine.
  const projects = useQuery({ queryKey: ['projects'], enabled: open && !editing, retry: false, queryFn: () => api<ProjectOption[]>('/api/projects').catch(() => []) }).data ?? [];
  const [name, setName] = useState('');
  const [serverId, setServerId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [composeFile, setComposeFile] = useState('docker-compose.yml');
  const [environment, setEnvironment] = useState<'staging' | 'production'>('staging');
  const [healthUrl, setHealthUrl] = useState('');
  const [build, setBuild] = useState('');
  const [env, setEnv] = useState<{ k: string; v: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ''); setServerId(editing?.serverId ?? ''); setProjectId(''); setWorkdir(editing?.workdir ?? '');
    setComposeFile(editing?.composeFile ?? 'docker-compose.yml'); setEnvironment(editing?.environment ?? 'staging');
    setHealthUrl(editing?.healthUrl ?? ''); setBuild(editing?.buildCommand?.join('\n') ?? ''); setEnv([]);
  }, [open, editing]);
  useEffect(() => { if (open && !editing && !serverId && servers[0]) setServerId(servers[0].id); }, [open, editing, serverId, servers]);

  const server = servers.find((s) => s.id === serverId);
  const save = useMutation({
    mutationFn: () => {
      const buildCommand = build.split('\n').map((l) => l.trim()).filter(Boolean);
      const common = { name, workdir, composeFile, environment, healthUrl: healthUrl.trim() || null, buildCommand: buildCommand.length ? buildCommand : null };
      if (editing) return api<Deployment>(`/api/deployments/${editing.id}`, { method: 'PATCH', body: common });
      return api<Deployment>('/api/deployments', { body: { ...common, serverId, projectId: projectId || null, env: Object.fromEntries(env.filter((e) => e.k.trim()).map((e) => [e.k.trim(), e.v])) } });
    },
    onSuccess: (d) => { void qc.invalidateQueries({ queryKey: ['deployments'] }); void qc.invalidateQueries({ queryKey: ['deployment', d.id] }); onOpenChange(false); onSaved?.(d); },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={editing ? `Settings · ${editing.name}` : 'New deployment'}
      description={editing ? 'Changes apply on the next deploy.' : 'A Docker Compose application on one of your servers. Nothing is started until you deploy it.'}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Name"><Input required autoFocus maxLength={80} placeholder="e.g. storefront" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Environment" hint={!admin ? 'production needs an administrator' : undefined}>
            <div><Segmented value={environment} onChange={(v) => (v === 'production' && !admin ? undefined : setEnvironment(v))}
              options={[{ value: 'staging', label: 'Staging' }, { value: 'production', label: 'Production' }]} /></div>
          </Field>
        </div>
        {!editing && (
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label="Server">
              <Select required value={serverId} onChange={(e) => { setServerId(e.target.value); setProjectId(''); }}>
                {servers.length === 0 ? <option value="">No servers enrolled</option> : null}
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'online' ? '' : ' (offline)'}</option>)}
              </Select>
            </Field>
            <Field label="Project" hint="optional">
              <Select value={projectId} onChange={(e) => {
                setProjectId(e.target.value);
                const p = projects.find((x) => x.id === e.target.value);
                if (p) { setWorkdir(p.path); if (!name) setName(p.name); }
              }}>
                <option value="">{projects.some((p) => p.serverId === serverId) ? 'None' : 'No projects on this server'}</option>
                {projects.filter((p) => p.serverId === serverId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <div className="grid gap-3 @md:grid-cols-[1fr_14rem]">
          <Field label="Working directory" hint="contains the compose file">
            <Input required className="font-mono" placeholder={server?.system?.roots[0] ? `${server.system.roots[0]}/app` : '/srv/app'} value={workdir} onChange={(e) => setWorkdir(e.target.value)} />
          </Field>
          <Field label="Compose file"><Input required className="font-mono" value={composeFile} onChange={(e) => setComposeFile(e.target.value)} /></Field>
        </div>
        <Field label="Health URL" hint="optional · checked from the server itself">
          <Input type="url" className="font-mono" placeholder="http://127.0.0.1:8080/health" value={healthUrl} onChange={(e) => setHealthUrl(e.target.value)} />
        </Field>
        <Field label="Build command" hint="optional · runs before compose up · one argument per line">
          <Textarea rows={2} className="min-h-0 font-mono" placeholder={'npm\nrun\nbuild'} value={build} onChange={(e) => setBuild(e.target.value)} />
        </Field>
        {!editing && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-sm text-fg-2">Environment variables<span className="text-xs text-fg-3">encrypted at rest · values are write-only</span></div>
            {env.map((row, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label={`Variable ${i + 1} name`} className="w-2/5 font-mono" placeholder="NAME" value={row.k} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, k: e.target.value } : r)))} />
                <Input aria-label={`Variable ${i + 1} value`} type="password" autoComplete="off" className="flex-1 font-mono" placeholder="value" value={row.v} onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, v: e.target.value } : r)))} />
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove variable ${i + 1}`} onClick={() => setEnv(env.filter((_, j) => j !== i))}><X /></Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setEnv([...env, { k: '', v: '' }])}><Plus />Add variable</Button>
          </div>
        )}
        {save.error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{errMsg(save.error)}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim() || !workdir.trim() || (!editing && !serverId)}>{editing ? 'Save settings' : 'Create deployment'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
