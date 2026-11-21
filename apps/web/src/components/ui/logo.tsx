/** VISCOSITY mark: three strata of a fluid settling — heavier, slower, at the bottom. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden>
      <path d="M3.5 6.5c2.8-2.2 5.7-2.2 8.5 0s5.7 2.2 8.5 0" strokeWidth="1.25" opacity="0.45" />
      <path d="M3.5 12c2.8-2.2 5.7-2.2 8.5 0s5.7 2.2 8.5 0" strokeWidth="1.75" opacity="0.75" />
      <path d="M3.5 17.5c2.8-2.2 5.7-2.2 8.5 0s5.7 2.2 8.5 0" strokeWidth="2.4" />
    </svg>
  );
}
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="font-medium tracking-[0.22em]">VISCOSITY</span>
      <span className="ml-2 font-mono text-2xs tracking-[0.2em] text-fg-3">CONTROL</span>
    </span>
  );
}
