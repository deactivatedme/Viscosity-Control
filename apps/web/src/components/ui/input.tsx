import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const base =
  'w-full rounded-md border border-line-strong bg-bg px-2.5 text-base text-fg placeholder:text-fg-4 transition-colors ' +
  'hover:border-fg-4 focus:border-fg-3 focus:outline-none disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(base, 'h-8', className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(base, 'py-2 leading-relaxed resize-y min-h-20', className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cn(base, 'h-8 appearance-none bg-[length:10px] bg-[right_10px_center] bg-no-repeat pr-7', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236c6c72' stroke-width='1.4'/%3E%3C/svg%3E\")" }} {...p}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline justify-between text-sm text-fg-2">
        {label}
        {hint ? <span className="text-xs text-fg-3">{hint}</span> : null}
      </span>
      {children}
      {error ? <span role="alert" className="block text-xs text-fg">{error}</span> : null}
    </label>
  );
}
