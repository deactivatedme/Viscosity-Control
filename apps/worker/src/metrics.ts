import { readdirSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import type { Metrics } from '@viscosity/protocol';
import { runningContainers } from './handlers/docker';

interface Sample {
  at: number;
  cpuTotal: number;
  cpuIdle: number;
  rx: number;
  tx: number;
}

function sample(): Sample {
  // "cpu  user nice system idle iowait irq softirq steal ..."
  const cpu = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0]!.trim().split(/\s+/).slice(1, 9).map(Number);
  let rx = 0;
  let tx = 0;
  for (const line of readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const [iface, rest] = line.split(':');
    if (!rest || iface!.trim() === 'lo') continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    rx += cols[0] ?? 0;
    tx += cols[8] ?? 0;
  }
  return { at: Date.now(), cpuTotal: cpu.reduce((a, b) => a + b, 0), cpuIdle: (cpu[3] ?? 0) + (cpu[4] ?? 0), rx, tx };
}

function meminfo(key: string, text: string): number {
  return Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? 0) * 1024;
}

/** Returns a collector; rates (cpu %, network bps) are deltas between consecutive calls. */
export function createMetricsCollector(activeAgents: () => number): () => Promise<Metrics> {
  let prev = sample();
  return async () => {
    const cur = sample();
    const dt = Math.max(1, cur.at - prev.at) / 1000;
    const total = cur.cpuTotal - prev.cpuTotal;
    const cpu = total > 0 ? (100 * (total - (cur.cpuIdle - prev.cpuIdle))) / total : 0;
    const netRxBps = Math.max(0, (cur.rx - prev.rx) / dt);
    const netTxBps = Math.max(0, (cur.tx - prev.tx) / dt);
    prev = cur;
    const mem = readFileSync('/proc/meminfo', 'utf8');
    const disk = await statfs('/');
    return {
      ts: cur.at,
      cpu: Math.round(cpu * 10) / 10,
      load: os.loadavg() as [number, number, number],
      memTotal: meminfo('MemTotal', mem),
      memAvailable: meminfo('MemAvailable', mem),
      diskTotal: disk.blocks * disk.bsize,
      diskUsed: (disk.blocks - disk.bfree) * disk.bsize,
      netRxBps: Math.round(netRxBps),
      netTxBps: Math.round(netTxBps),
      uptime: Math.round(os.uptime()),
      processes: readdirSync('/proc').filter((name) => /^\d+$/.test(name)).length,
      containers: await runningContainers(),
      agents: activeAgents(),
    };
  };
}
