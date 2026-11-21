import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { RpcError, type SystemInfo } from '@viscosity/protocol';
import { OK, type Ctx, type Handlers } from '../context';
import { exec, probe } from '../exec';
import { WORKER_VERSION } from '../version';
import { dockerAvailable } from './docker';

/** Optional SDKs are probed by actually importing them — the only check that matches what a run will do. */
const importable = (name: string): Promise<boolean> =>
  import(name).then(
    () => true,
    () => false,
  );

export async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false; // playwright is an optional dependency
  }
}

export async function systemInfo(ctx: Ctx): Promise<SystemInfo> {
  const release = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const cpus = os.cpus();
  const [docker, git, browser, claude, codex, pty] = await Promise.all([
    dockerAvailable(),
    probe('git', ['--version']),
    chromiumAvailable(),
    importable('@anthropic-ai/claude-agent-sdk'),
    importable('@openai/codex-sdk'),
    importable('node-pty'),
  ]);
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    distro: /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1] ?? os.type(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCores: cpus.length,
    memTotal: os.totalmem(),
    ips: Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal)
      .map((a) => a!.address),
    user: os.userInfo().username,
    workerVersion: WORKER_VERSION,
    roots: ctx.config.roots,
    services: ctx.config.services ?? [],
    capabilities: {
      pty: pty && (process.getuid?.() !== 0 || ctx.config.allowRootShell === true),
      docker,
      git,
      browser,
      claude,
      codex,
      reboot: ctx.config.allowReboot === true,
    },
  };
}

export function systemHandlers(ctx: Ctx): Pick<Handlers, 'system.info' | 'system.reboot' | 'system.logs'> {
  return {
    'system.info': () => systemInfo(ctx),
    'system.reboot': async () => {
      if (!ctx.config.allowReboot) throw new RpcError('forbidden', 'reboot is disabled in this worker\'s config (allowReboot)');
      await exec('systemctl', ['reboot']);
      return OK;
    },
    'system.logs': async ({ unit, lines }) => {
      if (!(await probe('journalctl', ['--version']))) throw new RpcError('unsupported', 'journalctl is not available on this host');
      const args = ['--no-pager', '-n', String(lines), '-o', 'short-iso'];
      if (unit) args.push('-u', unit);
      return { text: (await exec('journalctl', args)).stdout };
    },
  };
}
