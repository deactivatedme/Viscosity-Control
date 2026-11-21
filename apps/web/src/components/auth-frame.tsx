import type { ReactNode } from 'react';
import { Logo, Wordmark } from '@/components/ui/logo';

/** Shared chrome for the signed-out screens. */
export function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="vc-field flex min-h-dvh items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-sm animate-in">
        <div className="mb-8 flex items-center gap-3"><Logo className="size-6" /><Wordmark className="text-sm" /></div>
        <div className="rounded-xl border border-line-strong bg-panel/90 p-6 shadow-[0_24px_80px_rgb(0_0_0/0.5)] backdrop-blur">
          <h1 className="text-lg font-medium tracking-tight">{title}</h1>
          <p className="mt-1 text-sm leading-relaxed text-fg-3">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <div className="mt-4 text-center text-xs text-fg-3">{footer}</div> : null}
      </div>
    </main>
  );
}
