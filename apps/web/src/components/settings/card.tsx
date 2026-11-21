import type { ReactNode } from 'react';

export function Card({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line-strong bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
          {description ? <p className="mt-1 max-w-prose text-sm leading-relaxed text-fg-3">{description}</p> : null}
        </div>
        {action}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export const ErrorNote = ({ error }: { error: string | null }) =>
  error ? <p role="alert" className="mb-3 rounded-md border border-line-strong bg-bg px-3 py-2 text-sm">{error}</p> : null;
