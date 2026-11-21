'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card } from '@/components/settings/card';
import { CredentialsCard } from '@/components/settings/credentials';
import { MfaCard, PasswordCard } from '@/components/settings/security';
import { Segmented, SkeletonRows, View } from '@/components/ui/bits';
import { Field, Input, Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { useUi } from '@/lib/store';

type Tab = 'account' | 'providers' | 'terminal' | 'about';
const FONTS = ['Geist Mono', 'ui-monospace', 'Menlo', 'Consolas', 'Courier New'];

function Kv({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0"><dt className="text-sm text-fg-3">{k}</dt><dd className="text-right text-sm">{children}</dd></div>;
}

function TerminalCard() {
  const terminal = useUi((s) => s.terminal);
  const setTerminal = useUi((s) => s.setTerminal);
  return (
    <Card title="Terminal" description="Applies to every terminal tab in this browser, including ones already open.">
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <Field label="Font family">
          <Select value={terminal.fontFamily} onChange={(e) => setTerminal({ fontFamily: e.target.value })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</Select>
        </Field>
        <Field label="Font size" hint="10–22 px">
          <Input type="number" min={10} max={22} value={terminal.fontSize}
            onChange={(e) => { const n = Number(e.target.value); if (n >= 10 && n <= 22) setTerminal({ fontSize: n }); }} />
        </Field>
      </div>
      <pre aria-label="Terminal font preview" className="mt-4 overflow-x-auto rounded-lg border border-line-strong bg-bg p-3 leading-snug text-fg-2"
        style={{ fontFamily: `"${terminal.fontFamily}", ui-monospace, monospace`, fontSize: terminal.fontSize }}>
        {'viscosity@prod-fra-1:~$ systemctl status viscosity-worker\n● active (running) — 0O 1lI |{}[] => != ==='}
      </pre>
    </Card>
  );
}

function AboutCard() {
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api<{ protocol: number }>('/api/setup/status') });
  return (
    <Card title="About" description="VISCOSITY CONTROL — a self-hosted control plane for servers and AI agents.">
      <dl className="max-w-md">
        <Kv k="Worker protocol"><span className="font-mono">{status.data ? `v${status.data.protocol}` : status.error ? 'unavailable' : '…'}</span></Kv>
        <Kv k="Threat model"><span className="font-mono text-xs">docs/THREAT-MODEL.md</span></Kv>
        <Kv k="Deployment guide"><span className="font-mono text-xs">docs/DEPLOYMENT.md</span></Kv>
      </dl>
      <p className="mt-3 max-w-prose text-xs leading-relaxed text-fg-3">Both documents live in the repository this installation was deployed from. Workers must speak the same protocol version as the control plane; upgrade them together.</p>
    </Card>
  );
}

export default function Settings() {
  const me = useMe().data;
  const [tab, setTab] = useState<Tab>('account');
  const admin = me?.role === 'admin';
  const options: { value: Tab; label: string }[] = [
    { value: 'account', label: 'Account' },
    ...(admin ? [{ value: 'providers' as const, label: 'AI providers' }] : []),
    { value: 'terminal', label: 'Terminal' },
    { value: 'about', label: 'About' },
  ];
  return (
    <View title="Settings" actions={<Segmented value={tab} onChange={setTab} options={options} />}>
      {!me ? <SkeletonRows /> : (
        <div className="mx-auto max-w-3xl space-y-4">
          {tab === 'account' && (
            <>
              <Card title="Account">
                <dl className="max-w-md">
                  <Kv k="Email">{me.email}</Kv>
                  <Kv k="Role"><span className="capitalize">{me.role}</span></Kv>
                </dl>
              </Card>
              <PasswordCard />
              <MfaCard me={me} />
            </>
          )}
          {tab === 'providers' && admin && <CredentialsCard />}
          {tab === 'terminal' && <TerminalCard />}
          {tab === 'about' && <AboutCard />}
        </div>
      )}
    </View>
  );
}
