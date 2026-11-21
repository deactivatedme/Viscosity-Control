import { RpcError } from '@viscosity/protocol';
import { OK, type Ctx, type Handlers } from '../context';
import { exec, probe } from '../exec';

/** Health probes and the (config-allow-listed) systemd units this worker may control. */
export function extraHandlers(ctx: Ctx): Pick<Handlers, 'http.check' | 'service.list' | 'service.action'> {
  const allowed = ctx.config.services ?? [];
  return {
    // Runs on the server on purpose: health endpoints are usually bound to localhost.
    'http.check': async ({ url, timeoutMs }) => {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new RpcError('invalid', 'only http(s) URLs can be checked');
      const started = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        await res.body?.cancel();
        return { ok: res.status >= 200 && res.status < 400, status: res.status, ms: Date.now() - started };
      } catch (err) {
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        return { ok: false, status: null, ms: Date.now() - started, error: cause?.code ?? cause?.message ?? (err as Error).message };
      }
    },
    'service.list': async () => {
      if (allowed.length === 0) return [];
      if (!(await probe('systemctl', ['--version']))) throw new RpcError('unsupported', 'systemd is not available on this host');
      return Promise.all(allowed.map(async (name) => {
        const out = (await exec('systemctl', ['show', name, '-p', 'Description', '-p', 'ActiveState', '-p', 'SubState'])).stdout;
        const get = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out)?.[1] ?? '';
        return { name, description: get('Description'), active: get('ActiveState'), sub: get('SubState') };
      }));
    },
    'service.action': async ({ name, action }) => {
      if (!allowed.includes(name)) throw new RpcError('forbidden', `${name} is not listed under "services" in this worker's config`);
      await exec('systemctl', [action, name], { timeoutMs: 60_000 });
      return OK;
    },
  };
}
