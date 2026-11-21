'use client';
import * as M from '@radix-ui/react-dropdown-menu';
import * as T from '@radix-ui/react-tooltip';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Menu({ trigger, children, align = 'end' }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={6}
          className="z-50 min-w-44 rounded-lg border border-line-strong bg-raised p-1 shadow-[0_12px_40px_rgb(0_0_0/0.5)] data-[state=open]:animate-in">
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
export function MenuItem({ icon: Icon, children, onSelect, disabled, danger }: { icon?: LucideIcon; children: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <M.Item disabled={disabled} onSelect={onSelect}
      className={cn('flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors data-[disabled]:opacity-40',
        'data-[highlighted]:bg-active', danger ? 'text-fg' : 'text-fg-2 data-[highlighted]:text-fg')}>
      {Icon ? <Icon className="size-3.5" /> : null}
      {children}
    </M.Item>
  );
}
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-line" />;

export function Tip({ label, children, side = 'bottom' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 rounded-md border border-line-strong bg-raised px-2 py-1 text-xs text-fg-2 shadow-lg data-[state=delayed-open]:animate-in">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
