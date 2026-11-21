import WebSocket from 'ws';
import { Frame, PROTOCOL_VERSION } from '@viscosity/protocol';
import type { WorkerConfig } from './config';
import { errMessage, log } from './log';

const PING_TIMEOUT_MS = 45_000; // control plane pings every 15s

interface Hooks {
  hello(): Promise<Frame>;
  onFrame(frame: Frame): void;
}

/** Outbound WebSocket to the control plane with liveness watchdog and backoff reconnect. */
export class Connection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastSeen = 0;
  private ready = false;

  constructor(
    private config: WorkerConfig,
    private hooks: Hooks,
  ) {}

  start(): void {
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastSeen > PING_TIMEOUT_MS) {
        log('warn', 'control plane silent, reconnecting');
        this.ws.terminate();
      }
    }, 5000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.terminate();
  }

  /** Bytes queued but not yet flushed to the socket (backpressure signal). */
  get buffered(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** Returns false when offline; durable streams rely on the event log + replay instead. */
  send(frame: Frame): boolean {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.config.controlUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws/worker`;
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${this.config.serverId}.${this.config.secret}`,
        'x-viscosity-protocol': String(PROTOCOL_VERSION),
      },
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;
    this.lastSeen = Date.now();
    let retryMs: number | null = null;

    ws.on('open', async () => {
      try {
        ws.send(JSON.stringify(await this.hooks.hello()));
        this.ready = true;
        this.attempt = 0;
        log('info', 'connected to control plane', { url });
      } catch (err) {
        log('error', 'failed to send hello', { error: errMessage(err) });
        ws.terminate();
      }
    });
    ws.on('ping', () => (this.lastSeen = Date.now()));
    ws.on('message', (raw) => {
      this.lastSeen = Date.now();
      let frame: Frame;
      try {
        frame = Frame.parse(JSON.parse(raw.toString()));
      } catch (err) {
        log('warn', 'dropping malformed frame', { error: errMessage(err) });
        return;
      }
      this.hooks.onFrame(frame);
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        log('error', 'credential rejected by control plane — re-enroll this worker', { status: res.statusCode });
        retryMs = 60_000;
      } else {
        log('warn', 'control plane refused the connection', { status: res.statusCode });
      }
      ws.terminate();
    });
    ws.on('error', (err) => log('warn', 'connection error', { error: err.message }));
    ws.on('close', () => {
      this.ready = false;
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      const backoff = Math.min(30_000, 1000 * 2 ** this.attempt++);
      const delay = retryMs ?? backoff / 2 + Math.random() * (backoff / 2);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }
}
