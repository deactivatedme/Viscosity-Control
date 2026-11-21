import os from 'node:os';
import type { IPty } from 'node-pty';
import { RpcError } from '@viscosity/protocol';
import { OK, baseEnv, type Ctx, type Handlers } from '../context';

const SCROLLBACK_BYTES = 256 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const EXITED_TTL_MS = 5 * 60_000;

interface Session {
  proc: IPty;
  scrollback: string;
  alive: boolean;
  exitCode: number | null;
}

export interface PtyManager {
  handlers: Pick<Handlers, 'pty.open' | 'pty.attach' | 'pty.close' | 'pty.list'>;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  closeAll(): void;
}

/** PTY sessions outlive control-plane disconnects; `pty.attach` hands back the scrollback. */
export function createPtyManager(ctx: Ctx): PtyManager {
  const sessions = new Map<string, Session>();
  let drainTimer: NodeJS.Timeout | null = null;

  /** Stop reading from every pty while the socket is backed up, instead of buffering unboundedly. */
  function applyBackpressure(): void {
    if (drainTimer || ctx.buffered() < HIGH_WATER) return;
    for (const s of sessions.values()) if (s.alive) s.proc.pause();
    drainTimer = setInterval(() => {
      if (ctx.buffered() > LOW_WATER) return;
      clearInterval(drainTimer!);
      drainTimer = null;
      for (const s of sessions.values()) if (s.alive) s.proc.resume();
    }, 50);
  }

  return {
    handlers: {
      'pty.open': async ({ id, cols, rows, cwd }) => {
        if (process.getuid?.() === 0 && !ctx.config.allowRootShell) {
          throw new RpcError('forbidden', 'the worker runs as root and allowRootShell is not set; refusing to open a root shell');
        }
        if (sessions.has(id)) throw new RpcError('invalid', 'terminal session already exists');
        const dir = await ctx.guard(cwd ?? ctx.config.roots[0]!);
        const { spawn } = await import('node-pty');
        const shell = process.env.SHELL || '/bin/bash';
        const proc = spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: dir, env: { ...baseEnv(), TERM: 'xterm-256color' } });
        const session: Session = { proc, scrollback: '', alive: true, exitCode: null };
        sessions.set(id, session);
        proc.onData((chunk) => {
          session.scrollback = (session.scrollback + chunk).slice(-SCROLLBACK_BYTES);
          ctx.emit('pty.data', { id, data: Buffer.from(chunk, 'utf8').toString('base64') });
          applyBackpressure();
        });
        proc.onExit(({ exitCode }) => {
          session.alive = false;
          session.exitCode = exitCode;
          ctx.emit('pty.exit', { id, exitCode });
          setTimeout(() => sessions.delete(id), EXITED_TTL_MS).unref();
        });
        return { pid: proc.pid, shell, user: os.userInfo().username };
      },
      'pty.attach': async ({ id }) => {
        const s = sessions.get(id);
        if (!s) throw new RpcError('not_found', 'terminal session no longer exists on the worker');
        return { alive: s.alive, scrollback: Buffer.from(s.scrollback, 'utf8').toString('base64'), exitCode: s.exitCode };
      },
      'pty.close': async ({ id }) => {
        const s = sessions.get(id);
        if (s?.alive) s.proc.kill();
        sessions.delete(id);
        return OK;
      },
      'pty.list': async () => [...sessions].map(([id, s]) => ({ id, alive: s.alive })),
    },
    input(id, data) {
      const s = sessions.get(id);
      if (s?.alive) s.proc.write(Buffer.from(data, 'base64').toString('utf8'));
    },
    resize(id, cols, rows) {
      const s = sessions.get(id);
      if (s?.alive) s.proc.resize(cols, rows);
    },
    closeAll() {
      if (drainTimer) clearInterval(drainTimer);
      for (const s of sessions.values()) if (s.alive) s.proc.kill();
      sessions.clear();
    },
  };
}
