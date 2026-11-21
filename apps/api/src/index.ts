import { loadConfig } from './config';
import { buildApp } from './server';

const config = loadConfig();
const { app } = await buildApp(config);
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}
