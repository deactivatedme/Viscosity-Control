'use client';
import { useState, type FormEvent } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { api, ApiError, errMsg } from '@/lib/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api('/api/auth/login', { body: { email, password, code: needsCode ? code : undefined } });
      window.location.assign('/');
    } catch (err) {
      if (err instanceof ApiError && err.data.mfaRequired && !needsCode) setNeedsCode(true);
      else setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Sign in" subtitle="Access your servers and agents." footer="Self-hosted · sessions are httpOnly and expire after 7 days">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email"><Input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {needsCode && (
          <Field label="Verification code" hint="from your authenticator app">
            <Input inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-[0.3em]" />
          </Field>
        )}
        {error ? <p role="alert" className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{error}</p> : null}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full justify-center">{needsCode ? 'Verify and sign in' : 'Sign in'}</Button>
      </form>
    </AuthFrame>
  );
}
