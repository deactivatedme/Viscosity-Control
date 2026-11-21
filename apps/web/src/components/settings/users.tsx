'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, MoreHorizontal, Plus, ShieldOff, Trash2, UserCog } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, ErrorState, SkeletonRows, Td, Th } from '@/components/ui/bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/menu';
import { api, errMsg } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { Card, ErrorNote } from './card';

interface UserRow { id: string; email: string; role: 'admin' | 'operator' | 'viewer'; mfaEnabled: boolean; createdAt: string; activeSessions: number }
const ROLES: Record<UserRow['role'], string> = {
  admin: 'Everything, including servers, credentials, users and the audit log',
  operator: 'Run agents, terminals, files, deployments to staging; cannot enroll servers or manage keys',
  viewer: 'Read-only',
};

export function UsersCard() {
  const qc = useQueryClient();
  const me = useMe().data;
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<UserRow[]>('/api/users') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'operator' as UserRow['role'], password: '' });
  const [target, setTarget] = useState<{ user: UserRow; action: 'password' | 'delete' | 'role' } | null>(null);
  const [value, setValue] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/users', { body: form }),
    onSuccess: () => { void refresh(); toast(`${form.email} can now sign in`); setAdding(false); setForm({ email: '', role: 'operator', password: '' }); },
  });
  const patch = useMutation({
    mutationFn: (body: { role?: string; password?: string }) => api(`/api/users/${target!.user.id}`, { method: 'PATCH', body }),
    onSuccess: () => { void refresh(); toast('Saved — their other sessions were signed out'); setTarget(null); setValue(''); },
  });
  const simple = async (u: UserRow, path: string, done: string) => {
    try { await api(`/api/users/${u.id}/${path}`, { method: 'POST' }); await refresh(); toast(done); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <Card title="Users" description="People who can sign in to this control plane. Roles are enforced on the server for every request."
      action={<Button variant="primary" onClick={() => setAdding(true)}><Plus />Add user</Button>}>
      {q.isPending ? <SkeletonRows rows={2} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="-mx-5 -my-4 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr><Th>User</Th><Th>Role</Th><Th className="hidden @xl:table-cell">Two-factor</Th><Th className="hidden @xl:table-cell">Sessions</Th><Th className="hidden @3xl:table-cell">Added</Th><Th /></tr></thead>
            <tbody>
              {q.data.map((u) => (
                <tr key={u.id}>
                  <Td><span className="font-medium">{u.email}</span>{u.id === me?.id ? <span className="ml-2 text-xs text-fg-3">you</span> : null}</Td>
                  <Td><Badge>{u.role}</Badge></Td>
                  <Td className="hidden text-sm text-fg-2 @xl:table-cell">{u.mfaEnabled ? 'On' : 'Off'}</Td>
                  <Td className="tnum hidden font-mono text-xs text-fg-2 @xl:table-cell">{u.activeSessions}</Td>
                  <Td className="hidden text-sm text-fg-3 @3xl:table-cell">{dateTime(u.createdAt)}</Td>
                  <Td className="text-right">
                    <Menu trigger={<Button variant="ghost" size="icon" aria-label={`Actions for ${u.email}`}><MoreHorizontal /></Button>}>
                      <MenuItem icon={UserCog} onSelect={() => { setValue(u.role); setTarget({ user: u, action: 'role' }); }}>Change role…</MenuItem>
                      <MenuItem icon={KeyRound} onSelect={() => { setValue(''); setTarget({ user: u, action: 'password' }); }}>Set a new password…</MenuItem>
                      <MenuItem icon={LogOut} onSelect={() => simple(u, 'revoke-sessions', 'Sessions signed out')}>Sign out everywhere</MenuItem>
                      <MenuItem icon={ShieldOff} disabled={!u.mfaEnabled} onSelect={() => simple(u, 'reset-mfa', 'Two-factor reset')}>Reset two-factor</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={Trash2} danger disabled={u.id === me?.id} onSelect={() => setTarget({ user: u, action: 'delete' })}>Delete user…</MenuItem>
                    </Menu>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding} title="Add user" description="Share the password with them over a channel you trust; they can change it after signing in.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <ErrorNote error={create.error ? errMsg(create.error) : null} />
          <Field label="Email"><Input type="email" required autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role" hint={ROLES[form.role]}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRow['role'] })}>
              <option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option>
            </Select>
          </Field>
          <Field label="Initial password" hint="12+ characters"><Input type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <DialogFooter><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" variant="primary" loading={create.isPending}>Add user</Button></DialogFooter>
        </form>
      </Dialog>

      <Dialog open={target?.action === 'role' || target?.action === 'password'} onOpenChange={() => { setTarget(null); patch.reset(); }}
        title={target?.action === 'role' ? `Change role for ${target.user.email}` : `New password for ${target?.user.email}`}
        description="Their existing sessions are signed out when this is saved.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); patch.mutate(target!.action === 'role' ? { role: value } : { password: value }); }}>
          <ErrorNote error={patch.error ? errMsg(patch.error) : null} />
          {target?.action === 'role' ? (
            <Field label="Role" hint={ROLES[(value || 'viewer') as UserRow['role']]}>
              <Select value={value} onChange={(e) => setValue(e.target.value)}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></Select>
            </Field>
          ) : (
            <Field label="New password" hint="12+ characters"><Input type="password" autoComplete="new-password" autoFocus required minLength={12} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          )}
          <DialogFooter><Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button><Button type="submit" variant="primary" loading={patch.isPending}>Save</Button></DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog open={target?.action === 'delete'} onOpenChange={() => setTarget(null)} title={`Delete ${target?.user.email}?`} confirmLabel="Delete user"
        description="They are signed out immediately and can no longer sign in. Agents and sessions they started are kept."
        onConfirm={async () => { await api(`/api/users/${target!.user.id}`, { method: 'DELETE' }); await refresh(); }} />
    </Card>
  );
}
