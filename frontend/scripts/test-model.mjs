// Runs the pure read-model tests (no browser, no network): compiles the model + its test to a temp dir with the project's own TypeScript, then uses node:test.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'daii-model-test-'));
try {
  const dir = 'src/pages/vehicle-workspace';
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--ignoreConfig', '--types', 'node', '--skipLibCheck', '--esModuleInterop', '--strict', `${dir}/workspaceModel.ts`, 'tests/workspaceModel.test.ts'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['--test', join(out, 'tests', 'workspaceModel.test.js')], { stdio: 'inherit' });
} finally {
  rmSync(out, { recursive: true, force: true });
}
