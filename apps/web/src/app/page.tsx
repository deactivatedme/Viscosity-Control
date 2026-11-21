'use client';
import dynamic from 'next/dynamic';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/bits';
import { Logo } from '@/components/ui/logo';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';

const Shell = dynamic(() => import('@/components/shell/shell'), { ssr: false });

/** Gate: first run → /setup, signed out → /login, otherwise the workspace. */
export default function Home() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/api/auth/me');
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        const { needsSetup } = await api<{ needsSetup: boolean }>('/api/setup/status');
        return needsSetup ? ('setup' as const) : ('login' as const);
      }
    },
  });
  useEffect(() => { if (typeof me.data === 'string') window.location.replace(`/${me.data}`); }, [me.data]);

  if (me.error) return <div className="mx-auto mt-[20vh] max-w-md"><ErrorState error={me.error} onRetry={() => me.refetch()} /><p className="px-4 text-sm text-fg-3">The dashboard could not reach the control-plane API.</p></div>;
  if (!me.data || typeof me.data === 'string') return <div className="flex h-dvh items-center justify-center"><Logo className="size-7 animate-pulse text-fg-3" /></div>;
  return <Shell />;
}
