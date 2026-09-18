import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Reads the app's own `package.json` `version` field at call time — the
 * only place any "current version" concept exists today (no
 * SchemaVersion/ReleaseHistory table exists yet; building one is out of
 * Phase A's scope). Resolved from `process.cwd()`, matching `main.ts`'s
 * existing convention for locating `public/` — this app is always started
 * with `backend/` as the working directory (see
 * `PRODUCTION_DEPLOYMENT_GUIDE.md`), so `package.json` sits right there.
 * Falls back to `'unknown'` rather than throwing — a missing/unreadable
 * version must never block a backup from running.
 */
export function readAppVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
