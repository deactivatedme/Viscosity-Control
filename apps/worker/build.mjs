// Bundles the worker into dist/worker.mjs and writes a dist/package.json so a VPS can
// `npm install --omit=dev` just the runtime dependencies (native/optional ones stay external).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const OPTIONAL = ['playwright', '@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'];
const runtime = Object.entries(pkg.dependencies).filter(([name]) => !name.startsWith('@viscosity/'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: runtime.map(([name]) => name),
  alias: { '@viscosity/protocol': '../../packages/protocol/src/index.ts' },
  banner: { js: '#!/usr/bin/env node' },
  define: { 'process.env.VISCOSITY_WORKER_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info',
});
chmodSync('dist/worker.mjs', 0o755);

mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/package.json',
  `${JSON.stringify(
    {
      name: 'viscosity-worker',
      version: pkg.version,
      private: true,
      type: 'module',
      bin: { 'viscosity-worker': 'worker.mjs' },
      engines: { node: '>=22' },
      dependencies: Object.fromEntries(runtime.filter(([name]) => !OPTIONAL.includes(name))),
      optionalDependencies: Object.fromEntries(runtime.filter(([name]) => OPTIONAL.includes(name))),
    },
    null,
    2,
  )}\n`,
);
