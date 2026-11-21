import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** execFile (never a shell) with a timeout; rejects with the command's stderr as the message. */
export function exec(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 15_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message, { cause: err }));
        else resolve({ stdout, stderr });
      },
    );
  });
}

/** True when the binary exists and the probe command exits 0. */
export async function probe(file: string, args: string[]): Promise<boolean> {
  return exec(file, args, { timeoutMs: 4000 }).then(
    () => true,
    () => false,
  );
}
