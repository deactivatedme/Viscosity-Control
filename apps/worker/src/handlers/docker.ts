import { RpcError, type Container, type ContainerStats } from '@viscosity/protocol';
import { exec, probe } from '../exec';
import { OK, type Handlers } from '../context';

let cached: { at: number; ok: boolean } | null = null;

/** Whether the docker CLI can reach a daemon (cached 15s — metrics ask every tick). */
export async function dockerAvailable(): Promise<boolean> {
  if (!cached || Date.now() - cached.at > 15_000) {
    cached = { at: Date.now(), ok: await probe('docker', ['info', '--format', '{{.ServerVersion}}']) };
  }
  return cached.ok;
}

async function docker(args: string[]): Promise<string> {
  if (!(await dockerAvailable())) throw new RpcError('unsupported', 'docker is not installed or the daemon is not reachable by the worker user');
  return (await exec('docker', args, { timeoutMs: 60_000 })).stdout;
}

function jsonLines(out: string): Record<string, string>[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
}

/** "12.5MiB" / "1.2GB" / "500kB" → bytes */
export function parseSize(text: string): number {
  const m = /^([\d.]+)\s*([kKMGT]?)(i?)B$/.exec(text.trim());
  if (!m) return 0;
  const exponent = ['', 'k', 'M', 'G', 'T'].indexOf(m[2]!.replace('K', 'k'));
  return Math.round(Number(m[1]) * (m[3] ? 1024 : 1000) ** exponent);
}

export function parseContainer(row: Record<string, string>): Container {
  const labels = Object.fromEntries((row.Labels ?? '').split(',').map((l) => l.split('=', 2) as [string, string]));
  return {
    id: row.ID ?? '',
    name: row.Names ?? '',
    image: row.Image ?? '',
    state: row.State ?? '',
    status: row.Status ?? '',
    ports: row.Ports ?? '',
    createdAt: row.CreatedAt ?? '',
    composeProject: labels['com.docker.compose.project'] ?? null,
    health: /\((healthy|unhealthy|health: starting)\)/.exec(row.Status ?? '')?.[1]?.replace('health: ', '') ?? null,
  };
}

export async function runningContainers(): Promise<number | null> {
  if (!(await dockerAvailable())) return null;
  return (await exec('docker', ['ps', '-q'])).stdout.split('\n').filter(Boolean).length;
}

export const dockerHandlers: Pick<Handlers, 'docker.list' | 'docker.inspect' | 'docker.logs' | 'docker.action' | 'docker.stats'> = {
  'docker.list': async () => jsonLines(await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}'])).map(parseContainer),
  'docker.inspect': async ({ id }) => (JSON.parse(await docker(['inspect', id])) as unknown[])[0],
  'docker.logs': async ({ id, tail }) => {
    if (!(await dockerAvailable())) throw new RpcError('unsupported', 'docker is not available');
    const { stdout, stderr } = await exec('docker', ['logs', '--tail', String(tail), id], { timeoutMs: 30_000 });
    return { text: stdout + stderr };
  },
  'docker.action': async ({ id, action }) => {
    await docker([action, id]);
    return OK;
  },
  'docker.stats': async () =>
    jsonLines(await docker(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'])).map((row): ContainerStats => {
      const [used = '', limit = ''] = (row.MemUsage ?? '').split(' / ');
      return { id: row.ID ?? '', cpuPct: parseFloat(row.CPUPerc ?? '0') || 0, memUsed: parseSize(used), memLimit: parseSize(limit) };
    }),
};
