import { RpcError, type ProcessInfo } from '@viscosity/protocol';
import { OK, type Handlers } from '../context';
import { exec } from '../exec';

export const processHandlers: Pick<Handlers, 'process.list' | 'process.kill'> = {
  'process.list': async () => {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,user=,pcpu=,rss=,etime=,args=', '--sort=-pcpu']);
    const out: ProcessInfo[] = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      out.push({ pid: +m[1]!, ppid: +m[2]!, user: m[3]!, cpu: +m[4]!, rss: +m[5]! * 1024, elapsed: m[6]!, command: m[7]!.slice(0, 500) });
    }
    return out;
  },
  'process.kill': async ({ pid, signal }) => {
    if (pid === 1 || pid === process.pid) throw new RpcError('forbidden', 'refusing to signal init or the worker itself');
    try {
      process.kill(pid, `SIG${signal}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') throw new RpcError('not_found', `no process with pid ${pid}`);
      if (code === 'EPERM') throw new RpcError('forbidden', `the worker user may not signal pid ${pid}`);
      throw err;
    }
    return OK;
  },
};
