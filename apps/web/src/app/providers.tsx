'use client';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { useConnection } from '@/lib/ws';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } },
  }));
  // Every (re)connect of the event socket means we may have missed events: refetch everything.
  const epoch = useConnection((s) => s.epoch);
  useEffect(() => { if (epoch > 1) void qc.invalidateQueries(); }, [epoch, qc]);
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={350}>{children}</TooltipProvider>
      <Toaster theme="dark" position="bottom-right" gap={8}
        toastOptions={{ style: { background: '#141416', border: '1px solid #2e2e32', color: '#ededee', fontSize: 13, borderRadius: 10 } }} />
    </QueryClientProvider>
  );
}
