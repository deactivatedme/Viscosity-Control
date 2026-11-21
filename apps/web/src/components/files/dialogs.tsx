'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { errMsg } from '@/lib/api';

/** One-field dialog used for "New folder" and "Rename". */
export function NameDialog({ open, onOpenChange, title, label, initial, submitLabel, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; label: string; initial: string; submitLabel: string; onSubmit: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(initial); setError(null); } }, [open, initial]);
  const invalid = !name.trim() || name.includes('/') || name === '.' || name === '..';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try { await onSubmit(name.trim()); onOpenChange(false); } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
      }}>
        <Field label={label} error={error ?? (name.includes('/') ? 'A name cannot contain “/”' : null)}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={255} className="font-mono" onFocus={(e) => e.target.select()} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={invalid || name.trim() === initial}>{submitLabel}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
