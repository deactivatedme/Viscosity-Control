'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Agent, AgentEnvelope } from '@/lib/types';
import { useConnection, useTopic } from '@/lib/ws';

export const ACTIVE = ['queued', 'starting', 'running', 'waiting_approval'];
export const isActive = (status: string) => ACTIVE.includes(status);

/** Highest seq reachable from the first event without a hole. */
export function contiguousSeq(sorted: AgentEnvelope[]): number {
  let last = 0;
  for (const e of sorted) {
    if (last && e.seq !== last + 1) break;
    last = e.seq;
  }
  return last;
}

/**
 * Agent row + its full event history, kept live.
 * Postgres is the truth: history is fetched by seq, live envelopes are merged in (deduped by seq),
 * and any reconnect or seq gap triggers a refetch after the last contiguous seq.
 */
export function useAgentSession(id: string) {
  const qc = useQueryClient();
  const agent = useQuery({ queryKey: ['agent', id], queryFn: () => api<Agent>(`/api/agents/${id}`) });
  const refetchAgent = useCallback(() => void qc.invalidateQueries({ queryKey: ['agent', id] }), [qc, id]);

  const bySeq = useRef(new Map<number, AgentEnvelope>());
  const syncing = useRef(false);
  const again = useRef(false);
  const [events, setEvents] = useState<AgentEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const epoch = useConnection((s) => s.epoch);

  const merge = useCallback((incoming: AgentEnvelope[]) => {
    for (const e of incoming) bySeq.current.set(e.seq, e);
    setEvents([...bySeq.current.values()].sort((a, b) => a.seq - b.seq));
  }, []);

  const sync = useCallback(async () => {
    if (syncing.current) { again.current = true; return; }
    syncing.current = true;
    try {
      do {
        again.current = false;
        for (;;) {
          const after = contiguousSeq([...bySeq.current.values()].sort((a, b) => a.seq - b.seq));
          const batch = await api<AgentEnvelope[]>(`/api/agents/${id}/events?after=${after}`);
          merge(batch);
          if (batch.length < 1000) break;
        }
      } while (again.current);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      syncing.current = false;
      setLoading(false);
    }
  }, [id, merge]);

  useEffect(() => {
    bySeq.current = new Map();
    setEvents([]);
    setLoading(true);
  }, [id]);
  useEffect(() => { void sync(); }, [sync, epoch]);

  useTopic<Partial<AgentEnvelope>>(`agent:${id}`, (env) => {
    // The control plane also publishes bare status notices here (e.g. "lost"), which carry no event.
    if (typeof env.seq !== 'number' || !env.event) return refetchAgent();
    const max = Math.max(0, ...bySeq.current.keys());
    merge([env as AgentEnvelope]);
    if (env.seq > max + 1) void sync(); // missed something in between
    const t = env.event.type;
    if (t === 'status' || t === 'usage' || t === 'result' || t === 'approval_request' || t === 'approval_resolved') refetchAgent();
  });
  useTopic<{ id?: string }>('agents', (d) => { if (d.id === id) refetchAgent(); });
  useTopic<{ sessionId?: string }>('approvals', (d) => { if (d.sessionId === id) refetchAgent(); });

  return { agent, events, loading, error, retry: sync, refetchAgent };
}
