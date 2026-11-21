'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Metrics } from '@viscosity/protocol';
import { api } from './api';
import type { Agent, Alert, Approval, BrowserSession, Credential, Me, Server, Terminal } from './types';
import { useTopic } from './ws';

/** A list query kept fresh by a live topic (the event is only a hint to refetch). */
function useLive<T>(key: string, path: string, topic: string) {
  const qc = useQueryClient();
  useTopic(topic, () => void qc.invalidateQueries({ queryKey: [key] }));
  return useQuery({ queryKey: [key], queryFn: () => api<T>(path) });
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/auth/me'), staleTime: 60_000 });
export const useServers = () => useLive<Server[]>('servers', '/api/servers', 'servers');
export const useAgents = () => useLive<Agent[]>('agents', '/api/agents', 'agents');
export const useBrowsers = () => useLive<BrowserSession[]>('browsers', '/api/browser', 'browsers');
export const useTerminals = () => useLive<Terminal[]>('terminals', '/api/terminals', 'terminals');
export const useAlerts = () => useLive<Alert[]>('alerts', '/api/alerts', 'alerts');
export const useApprovals = () => useLive<Approval[]>('approvals', '/api/approvals', 'approvals');
export const useCredentials = () => useQuery({ queryKey: ['credentials'], queryFn: () => api<Credential[]>('/api/credentials') });

/** Live metrics for one server: seeds from REST, then appends pushed samples. Cleared when the server goes offline. */
export function useMetrics(serverId: string | null, online: boolean, seed?: Metrics[]) {
  const [history, setHistory] = useState<Metrics[]>(seed ?? []);
  // Seed only an empty history: callers pass a fresh array each render, and replacing state with it would loop.
  useEffect(() => { if (seed?.length) setHistory((h) => (h.length ? h : seed)); }, [seed]);
  useEffect(() => { if (!online) setHistory([]); }, [online]);
  useTopic<Metrics>(serverId ? `server:${serverId}` : null, (m) => setHistory((h) => [...h.slice(-149), m]));
  return { history, latest: history.at(-1) ?? null };
}
