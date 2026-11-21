import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  /** ≥32 chars. Encrypts stored provider credentials and MFA secrets. Losing it makes them unrecoverable. */
  VISCOSITY_SECRET_KEY: z.string().min(32),
  /** Comma-separated browser origins allowed to call the API, e.g. https://control.viscosity.one */
  PUBLIC_ORIGIN: z.string().min(1),
  /** URL workers use to reach the control plane, if different from the first PUBLIC_ORIGIN (e.g. a tailnet address). */
  WORKER_URL: z.string().url().optional(),
  /** GitHub REST base URL (override for GitHub Enterprise or tests). */
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default('./data'),
  /** Tarball of the built worker, served to servers being enrolled. */
  WORKER_BUNDLE: z.string().optional(),
  MIGRATIONS_DIR: z.string().optional(),
  /** Set when running behind Caddy/Traefik so client IPs come from X-Forwarded-For. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.string().default('info'),
  /** How often a metrics sample is persisted for history charts. */
  METRIC_SAMPLE_MS: z.coerce.number().int().min(1000).default(60_000),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // Compose passes unset optional variables as empty strings; treat those as absent.
  const e = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  const origins = e.PUBLIC_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, ''));
  return {
    databaseUrl: e.DATABASE_URL,
    secretKey: e.VISCOSITY_SECRET_KEY,
    origins,
    publicUrl: origins[0]!,
    workerUrl: (e.WORKER_URL ?? origins[0]!).replace(/\/$/, ''),
    cookieSecure: origins[0]!.startsWith('https://'),
    githubApiUrl: e.GITHUB_API_URL.replace(/\/$/, ''),
    port: e.PORT,
    host: e.HOST,
    dataDir: e.DATA_DIR,
    workerBundle: e.WORKER_BUNDLE,
    migrationsDir: e.MIGRATIONS_DIR,
    trustProxy: e.TRUST_PROXY === 'true',
    logLevel: e.LOG_LEVEL,
    metricSampleMs: e.METRIC_SAMPLE_MS,
  };
}
export type Config = ReturnType<typeof loadConfig>;
