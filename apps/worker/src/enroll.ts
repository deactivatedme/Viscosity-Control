import os from 'node:os';
import { EnrollResponse, PROTOCOL_VERSION } from '@viscosity/protocol';
import { assertSecureUrl, saveConfig, type WorkerConfig } from './config';

export interface EnrollOptions {
  url: string;
  token: string;
  configPath: string;
  roots: string[];
  dataDir: string;
  insecure?: boolean;
}

/** Exchanges a single-use enrollment token for this worker's long-lived credential and writes the config (0600). */
export async function enroll(opts: EnrollOptions): Promise<WorkerConfig> {
  const controlUrl = opts.url.replace(/\/+$/, '');
  assertSecureUrl(controlUrl, opts.insecure);
  const res = await fetch(`${controlUrl}/api/worker/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: opts.token, protocol: PROTOCOL_VERSION, hostname: os.hostname() }),
  });
  if (!res.ok) throw new Error(`enrollment rejected (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`);
  const { serverId, secret } = EnrollResponse.parse(await res.json());
  const config: WorkerConfig = { controlUrl, serverId, secret, roots: opts.roots, dataDir: opts.dataDir, ...(opts.insecure ? { insecure: true } : {}) };
  saveConfig(opts.configPath, config);
  return config;
}
