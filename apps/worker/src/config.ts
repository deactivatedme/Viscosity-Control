import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_CONFIG_PATH = '/etc/viscosity/worker.json';

const WorkerConfigSchema = z.object({
  controlUrl: z.string().url(),
  serverId: z.string().uuid(),
  secret: z.string().min(1),
  /** Directories file, terminal and agent operations are confined to. */
  roots: z.array(z.string()).min(1),
  /** Event logs and browser downloads. */
  dataDir: z.string(),
  metricsIntervalMs: z.number().int().min(500).optional(),
  allowRootShell: z.boolean().optional(),
  allowReboot: z.boolean().optional(),
  /** systemd units the dashboard may start/stop/restart (e.g. ["nginx.service"]). Host-side setting only. */
  services: z.array(z.string().regex(/^[\w@.:-]+$/)).optional(),
  /** Permit a plain http:// control URL on a non-loopback host. */
  insecure: z.boolean().optional(),
  browser: z
    .object({
      /** host or host:port entries exempt from the private-network block. Host-side setting only. */
      allowHosts: z.array(z.string()).optional(),
      proxy: z.string().optional(),
    })
    .optional(),
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadConfig(path: string): WorkerConfig {
  return WorkerConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveConfig(path: string, config: WorkerConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFile's mode is ignored when the file already exists
}

/** The worker credential travels on this URL, so plain http is only acceptable on loopback. */
export function assertSecureUrl(controlUrl: string, insecure = false): void {
  const url = new URL(controlUrl);
  if (url.protocol === 'https:' || url.protocol === 'wss:') return;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol === 'http:' || url.protocol === 'ws:') && (loopback || insecure)) return;
  throw new Error(`refusing unencrypted control URL ${controlUrl} (use https, or pass --insecure)`);
}
