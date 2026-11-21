import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { clip, type Adapter } from './types';

/** Runs an arbitrary agent CLI: argv from the dashboard + the prompt as the last argument, no shell. */
export const runCustom: Adapter = async (ctx) => {
  const [file, ...args] = ctx.params.command!;
  const child = spawn(file!, [...args, ctx.params.prompt], {
    cwd: ctx.cwd,
    env: ctx.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so stop reaches the agent's children too
  });
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // ESRCH: the group already exited
    }
  };
  const onAbort = (): void => {
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 5000).unref();
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  child.on('spawn', () => ctx.emit({ type: 'status', status: 'running' }));
  child.stdout.on('data', (chunk: Buffer) => ctx.emit({ type: 'output', stream: 'stdout', text: clip(chunk.toString()) }));
  child.stderr.on('data', (chunk: Buffer) => ctx.emit({ type: 'output', stream: 'stderr', text: clip(chunk.toString()) }));
  try {
    // 'error' (e.g. ENOENT) rejects here and is surfaced by the manager.
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    return { ok: code === 0, summary: signal ? `terminated by ${signal}` : `exited with code ${code}` };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
};
