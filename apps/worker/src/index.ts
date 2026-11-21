import os from 'node:os';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config';
import { enroll } from './enroll';
import { errMessage, log } from './log';
import { WORKER_VERSION } from './version';
import { startWorker } from './worker';

const USAGE = `viscosity-worker ${WORKER_VERSION}

Usage:
  viscosity-worker enroll --url <control-url> --token <token> [options]
      --config <path>     config file to write   (default ${DEFAULT_CONFIG_PATH})
      --root <dir>        directory the worker may access; repeatable (default: home directory)
      --data-dir <dir>    event logs and browser downloads (default /var/lib/viscosity)
      --insecure          allow a plain http:// control URL on a non-loopback host
  viscosity-worker run [--config <path>]
  viscosity-worker --version | --help
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      config: { type: 'string', default: DEFAULT_CONFIG_PATH },
      root: { type: 'string', multiple: true },
      'data-dir': { type: 'string', default: '/var/lib/viscosity' },
      insecure: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const command = positionals[0];
  if (values.version) return void console.log(WORKER_VERSION);
  if (values.help || !command) return void console.log(USAGE);

  if (command === 'enroll') {
    if (!values.url || !values.token) throw new Error('enroll requires --url and --token');
    const config = await enroll({
      url: values.url,
      token: values.token,
      configPath: values.config,
      roots: values.root?.length ? values.root : [os.homedir()],
      dataDir: values['data-dir'],
      insecure: values.insecure,
    });
    console.log(`Enrolled as server ${config.serverId}. Config written to ${values.config}.`);
    return;
  }
  if (command === 'run') {
    const worker = await startWorker(loadConfig(values.config));
    log('info', 'worker started', { version: WORKER_VERSION, config: values.config });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => void worker.stop().then(() => process.exit(0)));
    }
    return;
  }
  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((err: unknown) => {
  console.error(errMessage(err));
  process.exit(1);
});
