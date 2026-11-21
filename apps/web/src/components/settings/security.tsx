'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/browser/timeline';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, errMsg } from '@/lib/api';
import type { Me } from '@/lib/types';
import { Card, ErrorNote } from './card';

export function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== next;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/api/auth/password', { body: { current, next } });
      setCurrent(''); setNext(''); setConfirm('');
      toast('Password changed', { description: 'Every other session of this account was signed out.' });
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }
  return (
    <Card title="Password" description="Changing it signs out every other session of this account. This session stays signed in.">
      <form onSubmit={submit} className="max-w-sm space-y-3">
        <Field label="Current password"><Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="12+ characters"><Input type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : null}><Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={mismatch || !current || !next}>Change password</Button>
      </form>
    </Card>
  );
}

const codeInput = { inputMode: 'numeric' as const, autoComplete: 'one-time-code', maxLength: 6, pattern: '[0-9]{6}', className: 'font-mono tracking-[0.3em]' };

export function MfaCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setSetup(null); setDisabling(false); setCode(''); setPassword(''); setError(null); };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  };
  const begin = () => run(async () => setSetup(await api('/api/auth/mfa/setup', { method: 'POST' })));
  const enable = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    await api('/api/auth/mfa/enable', { body: { code } });
    await qc.invalidateQueries({ queryKey: ['me'] }); reset(); toast('Two-factor authentication is on');
  }); };
  const disable = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    await api('/api/auth/mfa/disable', { body: { password, code } });
    await qc.invalidateQueries({ queryKey: ['me'] }); reset(); toast('Two-factor authentication is off');
  }); };

  return (
    <Card title="Two-factor authentication" description="A time-based code (TOTP) from an authenticator app, required at every sign-in.">
      <div className="mb-4 flex items-center gap-2 text-sm">
        {me.mfaEnabled ? <><ShieldCheck className="size-4" />Enabled</> : <><ShieldOff className="size-4 text-fg-3" /><span className="text-fg-2">Not enabled</span></>}
      </div>

      {me.mfaEnabled ? (
        disabling ? (
          <form onSubmit={disable} className="max-w-sm space-y-3">
            <Field label="Password"><Input type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <div className="w-36"><Field label="Current code"><Input {...codeInput} required value={code} onChange={(e) => setCode(e.target.value)} /></Field></div>
            <ErrorNote error={error} />
            <div className="flex gap-2"><Button type="submit" variant="danger" loading={busy}>Disable two-factor</Button><Button variant="ghost" onClick={reset}>Cancel</Button></div>
          </form>
        ) : <Button onClick={() => setDisabling(true)}>Disable…</Button>
      ) : setup ? (
        <form onSubmit={enable} className="max-w-lg space-y-4">
          <div>
            <p className="mb-1.5 text-sm text-fg-2">1. Add this key to your authenticator app (manual entry, time-based, 6 digits).</p>
            <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-bg p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm tracking-wider" data-testid="mfa-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
              <CopyButton text={setup.secret} label="Copy secret key" />
            </div>
            <p className="mt-1.5 text-xs text-fg-3">On a device with an authenticator installed you can <a href={setup.otpauthUrl} className="text-fg-2 underline underline-offset-4 hover:text-fg">open the otpauth:// link</a> instead.</p>
          </div>
          <Field label="2. Enter the 6-digit code it shows"><div className="w-36"><Input {...codeInput} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} /></div></Field>
          <ErrorNote error={error} />
          <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy}>Verify and enable</Button><Button variant="ghost" onClick={reset}>Cancel</Button></div>
        </form>
      ) : (
        <>
          <ErrorNote error={error} />
          <Button onClick={begin} loading={busy}>Set up two-factor</Button>
        </>
      )}
    </Card>
  );
}
