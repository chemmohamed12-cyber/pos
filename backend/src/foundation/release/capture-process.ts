import { execFile } from 'child_process';

/** stdout/stderr as text whatever the runtime hands back (string, Buffer, undefined). */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

/**
 * Runs a binary with an argument ARRAY (never a shell) and resolves its stdout/stderr as TEXT through execFile's own callback — NOT `promisify(execFile)`.
 * Release 1.1.7 on the shared host: `const { stdout } = await promisify(execFile)(...)` yielded `stdout === undefined` (a CloudLinux/lsnode-wrapped child_process does not
 * carry execFile's custom promisify shape), so `stdout.trim()` threw "Cannot read properties of undefined (reading 'trim')" and the pre-swap environment check blocked a
 * valid release. The callback form always delivers (error, stdout, stderr), and asText makes the result a string in every case.
 */
export function runCapture(bin: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args as string[], { ...options, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        // keep the child's stderr in the message: the first line alone ("Command failed: ...") says nothing
        const e = err as Error & { stderr?: string };
        e.stderr = asText(stderr);
        reject(e);
        return;
      }
      resolve({ stdout: asText(stdout), stderr: asText(stderr) });
    });
  });
}
