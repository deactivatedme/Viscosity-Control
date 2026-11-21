import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const variants = {
  primary: 'bg-fg text-bg hover:bg-white border border-transparent font-medium',
  secondary: 'bg-raised text-fg border border-line-strong hover:bg-hover hover:border-fg-4',
  ghost: 'text-fg-2 hover:text-fg hover:bg-hover border border-transparent',
  danger: 'bg-transparent text-fg border border-fg-3 hover:bg-fg hover:text-bg font-medium',
} as const;
const sizes = { sm: 'h-7 px-2.5 text-sm gap-1.5', md: 'h-8 px-3 text-base gap-2', icon: 'h-7 w-7 justify-center', lg: 'h-10 px-4 text-base gap-2' } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, disabled, className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md whitespace-nowrap select-none transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
});
