import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export interface DependencyCheckResult {
  ok: boolean;
  /** Package names that failed to `require.resolve` — empty when `ok`. */
  missing: string[];
  detail: string;
}

/**
 * Proves every `dependencies` entry in `<treePath>/package.json` actually
 * resolves from that tree's own `node_modules` — a real subprocess probe,
 * not a manifest diff. Production Incident 2026-09-15 (`decimal.js` correctly
 * declared in `package.json`/`package-lock.json`, shipped in the release
 * artifact, but never actually installed on the target's shared nodevenv):
 * `manifest.dependencyChanges` (the field `ReleaseExecutionService`'s
 * Invariant I-9 guard reads) is declared in `ReleaseManifest`'s type but
 * never computed/populated anywhere in this pipeline — dead detection code.
 * This function is the real, working replacement: it doesn't need any
 * manifest field to be correctly maintained, it directly asks the tree
 * whether it can satisfy its own declared dependencies.
 *
 * Extracted into its own module (CTO Directive, Production Incident
 * 2026-09-15 post-mortem: "use the same real logic, never a parallel
 * implementation") so `StagedActivationService.verifyCandidate()` (the
 * pre-swap gate) and `ReleaseExecutionService`'s Migration Preflight (the
 * pre-activation report) call the exact same code — there is exactly one
 * implementation of "are the declared runtime dependencies actually
 * installed," never two that could silently disagree.
 */
export async function checkDependenciesResolve(treePath: string, nodeBin: string): Promise<DependencyCheckResult> {
  const pkgJsonPath = join(treePath, 'package.json');
  let depNames: string[];
  try {
    const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as { dependencies?: Record<string, string> };
    depNames = Object.keys(pkg.dependencies ?? {});
  } catch (err) {
    return { ok: false, missing: [], detail: `could not read/parse ${pkgJsonPath}: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (depNames.length === 0) {
    return { ok: true, missing: [], detail: 'no runtime dependencies declared in package.json' };
  }

  const probe = `
    const missing = [];
    for (const d of ${JSON.stringify(depNames)}) { try { require.resolve(d); } catch { missing.push(d); } }
    if (missing.length) { console.error(missing.join(',')); process.exit(1); }
  `;
  try {
    await execFileAsync(nodeBin, ['-e', probe], { cwd: treePath, timeout: 15_000 });
    return { ok: true, missing: [], detail: `all ${depNames.length} declared dependenc${depNames.length === 1 ? 'y' : 'ies'} resolve from the tree's node_modules` };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    const missing = stderr ? stderr.split(',').filter(Boolean) : [];
    return { ok: false, missing, detail: `missing from node_modules: ${stderr || (err instanceof Error ? err.message : String(err))}` };
  }
}
