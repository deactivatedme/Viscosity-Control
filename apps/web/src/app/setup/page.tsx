'use client';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';

const NEXT = ['Add your first server', 'Connect an AI provider', 'Launch your first agent'];

/** First run, step one: create the administrator. The remaining steps continue as a checklist on the Overview. */
export default function Setup() {
  const status = useQuery({ queryKey: ['setup'], queryFn: () => api<{ needsSetup: boolean }>('/api/setup/status') });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (status.data && !status.data.needsSetup) window.location.replace('/login'); }, [status.data]);

  const mismatch = confirm.length > 0 && confirm !== password;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true); setError(null);
    try {
      await api('/api/setup', { body: { email, password } });
      window.location.assign('/');
    } catch (err) { setError(errMsg(err)); setBusy(false); }
  }

  return (
    <AuthFrame title="Welcome to VISCOSITY CONTROL" subtitle="This installation has no accounts yet. Create the administrator — the only account that can enroll servers and store provider keys.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Administrator email"><Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password" hint="12+ characters"><Input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match' : null}><Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        {error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{error}</p> : null}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={mismatch} className="w-full justify-center">Create administrator</Button>
      </form>
      <ol className="mt-6 space-y-2 border-t pt-4 text-sm text-fg-3">
        <li className="flex items-center gap-2 text-fg"><span className="flex size-4 items-center justify-center rounded-full border border-fg"><Check className="size-2.5" /></span>Create the administrator</li>
        {NEXT.map((s, i) => <li key={s} className="flex items-center gap-2"><span className="flex size-4 items-center justify-center rounded-full border border-line-strong font-mono text-[9px]">{i + 2}</span>{s}</li>)}
      </ol>
    </AuthFrame>
  );
}
