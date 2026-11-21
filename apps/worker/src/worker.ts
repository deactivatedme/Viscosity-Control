import { mkdirSync } from 'node:fs';
import { controlEvents, methods, PROTOCOL_VERSION, RpcError, type ControlEventName, type Frame, type MethodName } from '@viscosity/protocol';
import { createAgentManager } from './agents/manager';
import { createBrowserManager } from './browser/manager';
import { assertSecureUrl, type WorkerConfig } from './config';
import { Connection } from './connection';
import type { Ctx, Handlers } from './context';
import { dockerHandlers } from './handlers/docker';
import { extraHandlers } from './handlers/extra';
import { fsHandlers } from './handlers/fs';
import { gitHandlers } from './handlers/git';
import { processHandlers } from './handlers/process';
import { createPtyManager } from './handlers/pty';
import { systemHandlers, systemInfo } from './handlers/system';
import { errMessage, log } from './log';
import { createMetricsCollector } from './metrics';
import { createPathGuard } from './paths';

export interface Worker {
  stop(): Promise<void>;
}

/** Starts the worker: connects out to the control plane and serves its requests until stopped. */
export async function startWorker(config: WorkerConfig): Promise<Worker> {
  assertSecureUrl(config.controlUrl, config.insecure);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  let conn: Connection;
  const ctx: Ctx = {
    config,
    guard: createPathGuard(config.roots),
    emit: (topic, data) => void conn.send({ t: 'evt', topic, data }),
    buffered: () => conn.buffered,
  };
  const ptys = createPtyManager(ctx);
  const agents = createAgentManager(ctx);
  const browsers = createBrowserManager(ctx);
  const handlers: Handlers = {
    ...systemHandlers(ctx),
    ...processHandlers,
    ...fsHandlers(ctx),
    ...dockerHandlers,
    ...extraHandlers(ctx),
    ...gitHandlers(ctx),
    ...ptys.handlers,
    ...agents.handlers,
    ...browsers.handlers,
  };

  async function handleRequest(id: string, method: string, params: unknown): Promise<Frame> {
    try {
      if (!Object.hasOwn(methods, method)) throw new RpcError('unsupported', `this worker does not implement ${method}`);
      const name = method as MethodName;
      const parsed = methods[name].params.safeParse(params);
      if (!parsed.success) throw new RpcError('invalid', parsed.error.message);
      const result = await (handlers[name] as (p: unknown) => Promise<unknown>)(parsed.data);
      return { t: 'res', id, ok: true, result };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : 'failed';
      if (code === 'failed') log('warn', 'request failed', { method, error: errMessage(err) });
      return { t: 'res', id, ok: false, error: { code, message: errMessage(err) } };
    }
  }

  function handleEvent(topic: string, data: unknown): void {
    if (!Object.hasOwn(controlEvents, topic)) return log('warn', 'ignoring unknown control event', { topic });
    const parsed = controlEvents[topic as ControlEventName].safeParse(data);
    if (!parsed.success) return log('warn', 'ignoring malformed control event', { topic, error: parsed.error.message });
    if (topic === 'pty.input') ptys.input(parsed.data.id, (parsed.data as { data: string }).data);
    else if (topic === 'pty.resize') {
      const { id, cols, rows } = parsed.data as { id: string; cols: number; rows: number };
      ptys.resize(id, cols, rows);
    }
  }

  conn = new Connection(config, {
    hello: async () => ({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      system: await systemInfo(ctx),
      agents: agents.sessions.known(),
      browsers: browsers.sessions.known(),
    }),
    onFrame: (frame) => {
      if (frame.t === 'req') void handleRequest(frame.id, frame.method, frame.params).then((res) => conn.send(res));
      else if (frame.t === 'evt') handleEvent(frame.topic, frame.data);
    },
  });

  const collect = createMetricsCollector(() => agents.sessions.activeCount);
  const metricsTimer = setInterval(() => {
    collect().then(
      (m) => ctx.emit('metrics', m),
      (err: unknown) => log('error', 'metrics collection failed', { error: errMessage(err) }),
    );
  }, config.metricsIntervalMs ?? 2000);

  conn.start();

  return {
    async stop() {
      clearInterval(metricsTimer);
      ptys.closeAll();
      agents.sessions.stopAll();
      browsers.sessions.stopAll();
      // Let aborted runs write their final events and release their child processes.
      const deadline = Date.now() + 10_000;
      while ((agents.sessions.activeCount || browsers.sessions.activeCount) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      conn.stop();
    },
  };
}
