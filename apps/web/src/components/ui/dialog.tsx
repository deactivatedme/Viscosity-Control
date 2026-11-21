'use client';
import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { errMsg } from '@/lib/api';
import { Button } from './button';
import { Input } from './input';

export function Dialog({ open, onOpenChange, title, description, children, wide }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <D.Content
          className={cn(
            '@container fixed left-1/2 top-[12vh] z-50 max-h-[80vh] w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-xl border border-line-strong',
            'bg-panel shadow-[0_24px_80px_rgb(0_0_0/0.6)] data-[state=open]:animate-in focus:outline-none', wide ? 'max-w-2xl' : 'max-w-md',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div>
              <D.Title className="text-[15px] font-medium tracking-tight">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-fg-3">{description}</D.Description> : null}
            </div>
            <D.Close className="rounded-md p-1 text-fg-3 transition-colors hover:bg-hover hover:text-fg" aria-label="Close"><X className="size-4" /></D.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="-mx-5 -mb-4 mt-5 flex justify-end gap-2 border-t bg-bg/40 px-5 py-3">{children}</div>;
}

/** Confirmation for dangerous operations. `typeToConfirm` forces the user to type a phrase (e.g. the server name). */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', typeToConfirm, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: ReactNode; confirmLabel?: string;
  typeToConfirm?: string; onConfirm: () => Promise<unknown> | void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (o: boolean) => { if (!o) { setTyped(''); setError(null); } onOpenChange(o); };
  return (
    <Dialog open={open} onOpenChange={close} title={title} description={description}>
      {typeToConfirm ? (
        <div className="space-y-1.5">
          <p className="text-sm text-fg-2">Type <span className="font-mono text-fg">{typeToConfirm}</span> to confirm.</p>
          <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation text" />
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-3 rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{error}</p> : null}
      <DialogFooter>
        <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
        <Button
          variant="danger" loading={busy} disabled={typeToConfirm ? typed !== typeToConfirm : false}
          onClick={async () => {
            setBusy(true); setError(null);
            try { await onConfirm(); close(false); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
          }}
        >{confirmLabel}</Button>
      </DialogFooter>
    </Dialog>
  );
}
