'use client';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

type Handler = (data: unknown) => void;

export const wsOrigin = () => process.env.NEXT_PUBLIC_WS_ORIGIN ?? window.location.origin.replace(/^http/, 'ws');

export const useConnection = create<{ state: 'connecting' | 'open' | 'closed'; epoch: number }>(() => ({ state: 'connecting', epoch: 0 }));

/**
 * One multiplexed, auto-reconnecting event socket for the whole dashboard.
 * Events are hints, REST is the truth: every (re)connect bumps `epoch`, which
 * the app uses to refetch, so missed events can never leave the UI stale.
 */
class EventSocket {
  private ws: WebSocket | null = null;
  private topics = new Map<string, Set<Handler>>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private connect() {
    if (this.ws || typeof window === 'undefined') return;
    const ws = new WebSocket(`${wsOrigin()}/ws/events`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      if (this.topics.size) ws.send(JSON.stringify({ op: 'sub', topics: [...this.topics.keys()] }));
      useConnection.setState((s) => ({ state: 'open', epoch: s.epoch + 1 }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { topic: string; data: unknown };
      for (const h of this.topics.get(msg.topic) ?? []) h(msg.data);
    };
    ws.onclose = () => {
      this.ws = null;
      useConnection.setState({ state: 'closed' });
      const delay = Math.min(15_000, 500 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      this.topics.set(topic, (set = new Set()));
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'sub', topics: [topic] }));
    }
    set.add(handler);
    this.connect();
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.topics.delete(topic);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'unsub', topics: [topic] }));
      }
    };
  }

  /** Used on logout so the next user starts clean. */
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }
}

export const events = new EventSocket();

/** Subscribe to a live topic for the lifetime of the component. Pass null to skip. */
export function useTopic<T = unknown>(topic: string | null, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!topic) return;
    return events.subscribe(topic, (d) => ref.current(d as T));
  }, [topic]);
}
