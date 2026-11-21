'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import type { Deployment } from './types';

/** Names are listed; values can only be set or replaced, never read back. */
export function EnvEditor({ deployment, canEdit }: { deployment: Deployment; canEdit: boolean }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (env: Record<string, string | null>) => api(`/api/deployments/${deployment.id}`, { method: 'PATCH', body: { env } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['deployment', deployment.id] }); void qc.invalidateQueries({ queryKey: ['deployments'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div>
      {deployment.envKeys.length === 0 ? <p className="px-4 py-3 text-sm text-fg-3">No environment variables. Compose receives only what its own file defines.</p> : (
        <ul className="divide-y">
          {deployment.envKeys.map((k) => (
            <li key={k} className="flex items-center gap-2 px-4 py-1.5">
              <KeyRound className="size-3.5 shrink-0 text-fg-3" strokeWidth={1.6} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{k}</span>
              {replacing === k ? (
                <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); patch.mutate({ [k]: replacement }, { onSuccess: () => { setReplacing(null); setReplacement(''); toast(`${k} replaced — applies on the next deploy`); } }); }}>
                  <Input autoFocus type="password" autoComplete="off" aria-label={`New value for ${k}`} placeholder="new value" className="h-7 w-44 font-mono" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
                  <Button size="sm" type="submit" variant="primary" loading={patch.isPending}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setReplacing(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <span className="font-mono text-xs text-fg-4">••••••••</span>
                  {canEdit ? <>
                    <Button size="sm" variant="ghost" onClick={() => { setReplacing(k); setReplacement(''); }}>Replace</Button>
                    <Button size="icon" variant="ghost" aria-label={`Remove ${k}`} onClick={() => setRemoving(k)}><Trash2 /></Button>
                  </> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form className="flex flex-wrap gap-2 border-t px-4 py-2.5" onSubmit={(e) => { e.preventDefault(); patch.mutate({ [key.trim()]: value }, { onSuccess: () => { setKey(''); setValue(''); toast('Variable saved — applies on the next deploy'); } }); }}>
          <Input aria-label="New variable name" placeholder="NAME" className="h-7 w-40 font-mono" value={key} onChange={(e) => setKey(e.target.value)} />
          <Input aria-label="New variable value" type="password" autoComplete="off" placeholder="value" className="h-7 min-w-32 flex-1 font-mono" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" type="submit" disabled={!key.trim()} loading={patch.isPending && !replacing}><Plus />Add</Button>
        </form>
      )}
      <ConfirmDialog open={!!removing} onOpenChange={() => setRemoving(null)} title={`Remove ${removing}?`} confirmLabel="Remove variable"
        description="The running containers keep the old value until the next deploy."
        onConfirm={async () => { await api(`/api/deployments/${deployment.id}`, { method: 'PATCH', body: { env: { [removing!]: null } } }); await qc.invalidateQueries({ queryKey: ['deployment', deployment.id] }); }} />
    </div>
  );
}
