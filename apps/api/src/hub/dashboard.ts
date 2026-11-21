import type { WebSocket } from 'ws';

const MAX_BUFFERED = 4 * 1024 * 1024;

/**
 * Topic pub/sub to dashboard browsers. Delivery is best-effort: every topic is
 * backed by REST state, so a client that falls behind is disconnected and
 * re-syncs on reconnect instead of the server buffering without bound.
 */
export class DashboardHub {
  private subs = new Map<WebSocket, Set<string>>();

  add(socket: WebSocket) {
    const topics = new Set<string>();
    this.subs.set(socket, topics);
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { op?: string; topics?: unknown };
        if (!Array.isArray(msg.topics)) return;
        for (const t of msg.topics.slice(0, 200)) {
          if (typeof t !== 'string' || t.length > 100) continue;
          if (msg.op === 'sub') topics.add(t);
          else if (msg.op === 'unsub') topics.delete(t);
        }
      } catch {
        socket.close(1003, 'malformed message');
      }
    });
    socket.on('close', () => this.subs.delete(socket));
    socket.on('error', () => this.subs.delete(socket));
  }

  /** `droppable` messages (metrics) are skipped for slow clients; others force a resync. */
  publish(topic: string, data: unknown, droppable = false) {
    let payload: string | undefined;
    for (const [socket, topics] of this.subs) {
      if (!topics.has(topic) || socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED) {
        if (!droppable) socket.close(1013, 'client too slow; reconnect to resync');
        continue;
      }
      socket.send((payload ??= JSON.stringify({ topic, data })));
    }
  }

  closeAll() {
    for (const s of this.subs.keys()) s.close(1001, 'server shutting down');
  }
}
