import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  Frame, RpcError, controlEvents, methods, workerEvents,
  type ControlEventData, type ControlEventName, type Metrics, type MethodName, type MethodParams, type MethodResult,
  type WorkerEventData, type WorkerEventName,
} from '@viscosity/protocol';
import type { FastifyBaseLogger } from 'fastify';

const PING_MS = 15_000;
const METRIC_HISTORY = 300; // shortcut: in-memory ring only (~10 min at 2 s); add a time-series store for long-range charts

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: MethodName;
}

interface Conn {
  socket: WebSocket;
  pending: Map<string, Pending>;
  alive: boolean;
  ping: NodeJS.Timeout;
  /** Serialises event handling so DB writes keep worker order. */
  queue: Promise<void>;
}

type HubEvents = {
  [E in WorkerEventName]: [serverId: string, data: WorkerEventData<E>];
} & { offline: [serverId: string]; hello: [serverId: string, hello: Hello] };
export type Hello = Extract<Frame, { t: 'hello' }>;

/**
 * Live worker connections. The only place that knows whether a server is online:
 * a server is online iff it has an attached, ping-responsive socket here.
 */
export class WorkerHub extends EventEmitter<HubEvents> {
  private conns = new Map<string, Conn>();
  private metrics = new Map<string, Metrics[]>();

  constructor(private log: FastifyBaseLogger) {
    super();
    this.setMaxListeners(0);
  }

  isOnline(serverId: string) {
    return this.conns.has(serverId);
  }
  onlineIds() {
    return [...this.conns.keys()];
  }
  latestMetrics(serverId: string): Metrics | null {
    return this.metrics.get(serverId)?.at(-1) ?? null;
  }
  metricHistory(serverId: string): Metrics[] {
    return this.metrics.get(serverId) ?? [];
  }

  /** Attach an authenticated socket. Replaces (and closes) any previous connection for the same server. */
  attach(serverId: string, socket: WebSocket, onClosed: () => void) {
    this.conns.get(serverId)?.socket.close(4000, 'replaced by a newer connection');
    const conn: Conn = {
      socket,
      pending: new Map(),
      alive: true,
      queue: Promise.resolve(),
      ping: setInterval(() => {
        if (!conn.alive) return socket.terminate(); // missed a whole ping interval
        conn.alive = false;
        socket.ping();
      }, PING_MS),
    };
    this.conns.set(serverId, conn);
    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (raw) => {
      conn.alive = true;
      this.onFrame(serverId, conn, raw.toString());
    });
    socket.on('close', () => {
      clearInterval(conn.ping);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RpcError('offline', 'worker disconnected before replying'));
      }
      conn.pending.clear();
      if (this.conns.get(serverId) === conn) {
        this.conns.delete(serverId);
        this.metrics.delete(serverId);
        this.emit('offline', serverId);
        onClosed();
      }
    });
    socket.on('error', (err) => this.log.warn({ serverId, err }, 'worker socket error'));
  }

  private onFrame(serverId: string, conn: Conn, raw: string) {
    let frame: Frame;
    try {
      frame = Frame.parse(JSON.parse(raw));
    } catch (err) {
      this.log.warn({ serverId, err }, 'dropping malformed worker frame');
      return;
    }
    if (frame.t === 'res') {
      const p = conn.pending.get(frame.id);
      if (!p) return;
      conn.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (!frame.ok) return p.reject(new RpcError(frame.error?.code ?? 'failed', frame.error?.message ?? 'worker error'));
      const parsed = methods[p.method].result.safeParse(frame.result);
      if (!parsed.success) return p.reject(new RpcError('failed', `worker returned an invalid ${p.method} result`));
      return p.resolve(parsed.data);
    }
    if (frame.t === 'evt') {
      if (!(frame.topic in workerEvents)) return;
      const topic = frame.topic as WorkerEventName;
      const parsed = workerEvents[topic].safeParse(frame.data);
      if (!parsed.success) {
        this.log.warn({ serverId, topic }, 'dropping invalid worker event');
        return;
      }
      if (topic === 'metrics') {
        const ring = this.metrics.get(serverId) ?? [];
        ring.push(parsed.data as Metrics);
        if (ring.length > METRIC_HISTORY) ring.shift();
        this.metrics.set(serverId, ring);
      }
      // Listeners may be async; chain them so events are applied in arrival order.
      conn.queue = conn.queue
        .then(async () => {
          for (const l of this.listeners(topic)) await (l as (...a: unknown[]) => unknown)(serverId, parsed.data);
        })
        .catch((err) => this.log.error({ serverId, topic, err }, 'worker event handler failed'));
    }
  }

  /** Queue the hello handlers (reconciliation) behind anything already received from this worker. */
  emitHello(serverId: string, raw: unknown) {
    const conn = this.conns.get(serverId);
    const frame = Frame.safeParse(raw);
    if (!conn || !frame.success || frame.data.t !== 'hello') return;
    const hello = frame.data;
    conn.queue = conn.queue
      .then(async () => {
        for (const l of this.listeners('hello')) await (l as (...a: unknown[]) => unknown)(serverId, hello);
      })
      .catch((err) => this.log.error({ serverId, err }, 'hello handler failed'));
  }

  /** Resolves once every event received so far from this worker has been handled. */
  drained(serverId: string): Promise<void> {
    return this.conns.get(serverId)?.queue ?? Promise.resolve();
  }

  call<M extends MethodName>(serverId: string, method: M, params: MethodParams<M>, timeoutMs = 30_000): Promise<MethodResult<M>> {
    const conn = this.conns.get(serverId);
    if (!conn) return Promise.reject(new RpcError('offline', 'server is offline'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new RpcError('timeout', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      conn.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      conn.socket.send(JSON.stringify({ t: 'req', id, method, params } satisfies Frame));
    });
  }

  /** Fire-and-forget control event (terminal input/resize). Returns false if the server is offline. */
  send<E extends ControlEventName>(serverId: string, topic: E, data: ControlEventData<E>): boolean {
    const conn = this.conns.get(serverId);
    if (!conn) return false;
    conn.socket.send(JSON.stringify({ t: 'evt', topic, data: controlEvents[topic].parse(data) } satisfies Frame));
    return true;
  }

  closeAll() {
    for (const c of this.conns.values()) c.socket.close(1001, 'control plane shutting down');
  }
  disconnect(serverId: string, reason: string) {
    this.conns.get(serverId)?.socket.close(4001, reason);
  }
}
