import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Reads an optional `<appRoot>/dist/build-info.json` written by
 * `build-release.sh` (`{ "buildTag": "...", "note": "...", "stampedAt": "..." }`).
 *
 * This is the observable `GET /api/release/version` uses for
 * `DLT-TEST-001` (`RELEASE_ENGINES_SPEC.md` rev-3 — dependency #1): the
 * pipeline's proof deploys a payload that adds/changes `dist/build-info.json`,
 * and the test asserts `buildTag` flips, then reverts to `null` after the
 * deliberate rollback.
 *
 * Never throws — a missing / unreadable / malformed file returns
 * `{ buildTag: null }`. `appRoot` defaults to `process.cwd()` (matching
 * `readAppVersion()`'s convention).
 */
export interface BuildInfo {
  buildTag: string | null;
  note?: string;
  stampedAt?: string;
}

export function readBuildInfo(appRoot: string = process.cwd()): BuildInfo {
  try {
    const raw = readFileSync(join(appRoot, 'dist', 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tag = parsed.buildTag;
    return {
      buildTag: typeof tag === 'string' && tag.length > 0 ? tag : null,
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
      stampedAt: typeof parsed.stampedAt === 'string' ? parsed.stampedAt : undefined,
    };
  } catch {
    return { buildTag: null };
  }
}
