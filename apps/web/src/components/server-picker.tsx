'use client';
import { Select } from '@/components/ui/input';
import type { Server } from '@/lib/types';

/** Server chooser for the per-server views (files, containers, terminals). Offline servers are listed but marked. */
export function ServerPicker({ servers, value, onChange, className }: { servers: Server[]; value: string | null; onChange: (id: string) => void; className?: string }) {
  return (
    <Select aria-label="Server" value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={className ?? 'w-44'}>
      {value ? null : <option value="" disabled>Choose a server…</option>}
      {servers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'online' ? '' : ` (${s.status === 'pending' ? 'not enrolled' : 'offline'})`}</option>)}
    </Select>
  );
}

/** The picked server if it still exists, otherwise the first online one. */
export function pickServer(servers: Server[] | undefined, id: string | null): Server | null {
  return servers?.find((s) => s.id === id) ?? servers?.find((s) => s.status === 'online') ?? null;
}
