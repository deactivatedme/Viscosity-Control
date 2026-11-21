'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, EmptyState, ErrorState, SkeletonRows, Td, Th } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import { ago } from '@/lib/format';
import { useCredentials } from '@/lib/queries';
import type { Credential } from '@/lib/types';
import { Card } from './card';

const KINDS: Record<Credential['kind'], { label: string; used: string; placeholder: string }> = {
  anthropic: { label: 'Anthropic', used: 'Claude agents and autonomous browser sessions', placeholder: 'sk-ant-…' },
  openai: { label: 'OpenAI', used: 'Codex agents', placeholder: 'sk-…' },
  github: { label: 'GitHub', used: 'Repository access for Projects; passed to agents as GITHUB_TOKEN', placeholder: 'ghp_… or github_pat_…' },
  secret: { label: 'Secret', used: 'Any value (e.g. a site password); use it in browser steps as {{secret:label}}', placeholder: 'value' },
};

export function CredentialsCard() {
  const qc = useQueryClient();
  const creds = useCredentials();
  const refresh = () => qc.invalidateQueries({ queryKey: ['credentials'] });
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<Credential | null>(null);
  const [deleting, setDeleting] = useState<Credential | null>(null);
  const [kind, setKind] = useState<Credential['kind']>('anthropic');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const closeForms = () => { setAdding(false); setRotating(null); setLabel(''); setSecret(''); add.reset(); rotate.reset(); };

  const add = useMutation({
    mutationFn: () => api('/api/credentials', { body: { kind, label, secret } }),
    onSuccess: () => { void refresh(); closeForms(); toast('Credential stored'); },
  });
  const rotate = useMutation({
    mutationFn: () => api(`/api/credentials/${rotating!.id}`, { method: 'PUT', body: { secret } }),
    onSuccess: () => { void refresh(); closeForms(); toast('Credential rotated', { description: 'Runs started from now on use the new secret.' }); },
  });

  return (
    <Card title="AI providers & secrets"
      description="Secrets are write-only: they are encrypted at rest, never sent back to this browser (only the last 4 characters are shown), and handed to a worker over its authenticated connection only at the moment a run starts."
      action={<Button variant="primary" onClick={() => setAdding(true)}><Plus />Add credential</Button>}>
      {creds.isPending ? <SkeletonRows rows={2} /> : creds.error ? <ErrorState error={creds.error} onRetry={() => creds.refetch()} />
        : creds.data.length === 0 ? (
          <EmptyState icon={KeyRound} title="No credentials stored">Add an Anthropic or OpenAI API key to launch Claude or Codex agents and autonomous browser sessions.</EmptyState>
        ) : (
          <div className="-mx-5 -my-4 overflow-x-auto">
            <table className="w-full border-collapse text-base">
              <thead><tr><Th>Label</Th><Th>Provider</Th><Th>Secret</Th><Th className="hidden @md:table-cell">Added</Th><Th /></tr></thead>
              <tbody>
                {creds.data.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-medium">{c.label}</Td>
                    <Td><Badge>{KINDS[c.kind].label}</Badge></Td>
                    <Td className="font-mono text-xs text-fg-2">••••••••{c.hint.replace('…', '')}</Td>
                    <Td className="hidden text-sm text-fg-3 @md:table-cell">{ago(c.createdAt)}{c.rotatedAt ? ` · rotated ${ago(c.rotatedAt)}` : ''}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-0.5">
                        <Button variant="ghost" size="icon" aria-label={`Rotate ${c.label}`} onClick={() => setRotating(c)}><RotateCw /></Button>
                        <Button variant="ghost" size="icon" aria-label={`Delete ${c.label}`} onClick={() => setDeleting(c)}><Trash2 /></Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <Dialog open={adding} onOpenChange={(o) => !o && closeForms()} title="Add credential" description="Stored encrypted. You will not be able to view it again.">
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="space-y-4">
          <Field label="Provider" hint={KINDS[kind].used}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as Credential['kind'])}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
          </Field>
          <Field label="Label"><Input required autoFocus maxLength={80} placeholder="e.g. Production key" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="Secret" error={add.error ? errMsg(add.error) : null}>
            <Input type="password" autoComplete="off" required minLength={8} placeholder={KINDS[kind].placeholder} value={secret} onChange={(e) => setSecret(e.target.value)} className="font-mono" />
          </Field>
          <DialogFooter><Button variant="ghost" onClick={closeForms}>Cancel</Button><Button type="submit" variant="primary" loading={add.isPending}>Store credential</Button></DialogFooter>
        </form>
      </Dialog>

      <Dialog open={!!rotating} onOpenChange={(o) => !o && closeForms()} title={`Rotate ${rotating?.label ?? ''}`}
        description="Replaces the stored secret. Runs already in progress keep the old one until they finish; revoke the old key at the provider afterwards.">
        <form onSubmit={(e) => { e.preventDefault(); rotate.mutate(); }} className="space-y-4">
          <Field label="New secret" error={rotate.error ? errMsg(rotate.error) : null}>
            <Input type="password" autoComplete="off" required autoFocus minLength={8} value={secret} onChange={(e) => setSecret(e.target.value)} className="font-mono" />
          </Field>
          <DialogFooter><Button variant="ghost" onClick={closeForms}>Cancel</Button><Button type="submit" variant="primary" loading={rotate.isPending}>Rotate</Button></DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.label ?? ''}?`} confirmLabel="Delete credential"
        description="Agents and browser sessions configured with this credential will fail to authenticate on their next run. The key itself is not revoked at the provider."
        onConfirm={async () => { await api(`/api/credentials/${deleting!.id}`, { method: 'DELETE' }); await refresh(); toast('Credential deleted'); }} />
    </Card>
  );
}
