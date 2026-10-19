import { access, stat } from 'fs/promises';
import { constants as FS } from 'fs';

export interface BinaryDiagnosis {
  ok: boolean;
  /** `pass` detail is the path; every failure names the environment variable to set and why the value was refused. */
  detail: string;
}

const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);

/**
 * Release Center deploy preflight - why a configured executable is (not) usable. The absolute-path rule is deliberately kept (v1.0.3 report item 13/14);
 * this only makes the refusal precise. It checks existence, kind and the execute permission with `stat` / `access` ONLY - the program is never invoked.
 */
export async function diagnoseBinary(envVar: string, bin: string | undefined | null): Promise<BinaryDiagnosis> {
  const value = (bin ?? '').trim();
  if (!value) return { ok: false, detail: `${envVar} is not set - set ${envVar} to the absolute path of the executable.` };
  if (!isAbsolutePath(value)) {
    return {
      ok: false,
      detail: `"${value}" is not an absolute path (${envVar}). A bare command name is resolved from PATH, which the deploy cannot rely on - set ${envVar} to the full path of the executable (v1.0.3 report item 13/14).`,
    };
  }
  let info;
  try {
    info = await stat(value);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, detail: code === 'ENOENT' || code === 'ENOTDIR' ? `"${value}" (${envVar}) does not exist on this host.` : `"${value}" (${envVar}) cannot be inspected (${code ?? 'error'}).` };
  }
  if (!info.isFile()) return { ok: false, detail: `"${value}" (${envVar}) is not a file (it is a directory or special file) - point it at the executable itself.` };
  try {
    await access(value, FS.X_OK);
  } catch {
    return { ok: false, detail: `"${value}" (${envVar}) exists but is not executable by the application user - fix the file permissions.` };
  }
  return { ok: true, detail: value };
}
