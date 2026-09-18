import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { open, stat } from 'fs/promises';
import { isAbsolute } from 'path';
import { AppConfigService, DatabaseConfig } from '../configuration/app-config.service';

const execFileAsync = promisify(execFile);

/** 10 minutes — generous for this project's current data volume (confirmed small in every prior live check this session — tens of rows per table); revisit if the real catalog grows enough to need a longer ceiling. */
const DUMP_TIMEOUT_MS = 10 * 60 * 1000;
const RESTORE_LIST_TIMEOUT_MS = 60 * 1000;
const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * `execFile` defaults `maxBuffer` to 1 MiB. `pg_dump -Fc` writes the archive
 * to `-f`, not stdout, so its own stdout stays tiny — but `pg_restore --list`
 * prints the FULL table-of-contents to stdout, which for a schema this size
 * (~120 tables + indexes + sequences + functions + seed data) can exceed
 * 1 MiB and make `execFileAsync` throw `stdout maxBuffer exceeded` — which
 * `verifyDumpStructure` then swallowed as "not structurally valid", flagging
 * a perfectly good dump as failed (Backup Gate Fix, 2026-08-31). 64 MiB is
 * far above any realistic TOC.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** The 5-byte magic every PostgreSQL custom-format (`-Fc`) archive starts with. A plain-SQL file does not. */
const PGDMP_MAGIC = 'PGDMP';

/**
 * `promisify(execFile)` normally resolves `{ stdout, stderr }` as utf8
 * strings — but a CloudLinux `pg_restore` shim / a wrapped binary / an
 * odd Passenger runtime can hand back `undefined` (or a Buffer) for
 * `stdout` even on a clean exit 0. Calling `.split()`/`.trim()` on that
 * threw `Cannot read properties of undefined (reading 'split')` and turned
 * a perfectly valid dump into `verification_failed` (2026-08-31). Every
 * stdout/stderr read below goes through this.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

export interface DumpVerifyResult {
  ok: boolean;
  /** Human-readable reason — the real `pg_restore --list` message on failure, or the TOC entry count on success. Recorded on the artifact so an operator sees exactly why. */
  detail: string;
}

/**
 * Release Center — Phase A (Backup Foundation). The ONLY place in this
 * codebase that shells out to an external binary — confirmed via a full
 * repo search that no `child_process` precedent existed before this.
 * Deliberately isolated in its own tiny service (not inlined into
 * `BackupManagerService`) so it's independently mockable in tests and
 * reusable by the Restore Manager in a later phase.
 *
 * SECURITY: always `execFile` with an argument ARRAY, never `exec` with a
 * shell string — no argument here is ever concatenated into a command
 * string, so there is no shell-injection surface regardless of what a
 * database/user/host value contains. The password is passed via the
 * `PGPASSWORD` environment variable (the standard libpq mechanism), never
 * as a CLI argument — CLI arguments are visible to any other process on
 * the same host via `ps`/`/proc`, environment variables passed to a
 * specific child process are not exposed the same way.
 */
@Injectable()
export class PgDumpRunnerService {
  private readonly logger = new Logger(PgDumpRunnerService.name);

  constructor(private readonly config: AppConfigService) {}

  private binHint(bin: string): string {
    return isAbsolute(bin)
      ? bin
      : `"${bin}" (NOT an absolute path — this resolved via the Passenger process PATH to whatever "${bin}" that host happens to expose; set PG_DUMP_BIN / PG_RESTORE_BIN to the absolute CloudLinux path — see PRODUCTION_DEPLOYMENT_GUIDE.md)`;
  }

  /**
   * Runs `pg_dump` in custom format (`-Fc`) directly to `outputFilePath` —
   * pg_dump writes the file itself; this process never buffers the dump
   * content in memory, which matters since a production dump could be
   * arbitrarily large.
   *
   * Backup Gate Fix (2026-08-31): a bad `pg_dump` (wrong binary on PATH, a
   * version that doesn't honour `-Fc`, a truncated write) used to exit 0,
   * leave a plain-SQL / partial file, and be recorded as a "completed"
   * artifact that only failed later at verification. Now `dump()` itself:
   *   1. captures pg_dump's stderr,
   *   2. asserts the output file exists, is non-empty, and starts with the
   *      `PGDMP` custom-format magic (a text-format file fails here), and
   *   3. runs `pg_restore --list` as the definitive structural check —
   * so a dump that cannot be restored is NEVER recorded as an artifact.
   */
  async dump(db: DatabaseConfig, outputFilePath: string): Promise<void> {
    const { pgDumpBin } = this.config.releaseBackup;
    const args = [
      '--host', db.host,
      '--port', String(db.port),
      '--username', db.username,
      '--no-password',
      '--format=custom',
      '--file', outputFilePath,
      '--dbname', db.database,
    ];

    let stderr = '';
    try {
      const result = await execFileAsync(pgDumpBin, args, {
        env: { ...process.env, PGPASSWORD: db.password },
        timeout: DUMP_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      stderr = asText(result?.stderr).trim();
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown };
      this.logger.error(`pg_dump failed for database "${db.database}"`, e.stack ?? String(err));
      const detail = asText(e?.stderr).trim() || (err instanceof Error ? err.message : String(err));
      throw new Error(`pg_dump (${this.binHint(pgDumpBin)}) failed: ${detail}`);
    }

    // 1. file present + non-empty
    let size: number;
    try {
      size = (await stat(outputFilePath)).size;
    } catch {
      throw new Error(`pg_dump (${this.binHint(pgDumpBin)}) exited 0 but wrote no file at "${outputFilePath}". stderr: ${stderr || '(none)'}`);
    }
    if (size === 0) {
      throw new Error(`pg_dump (${this.binHint(pgDumpBin)}) produced a 0-byte file. stderr: ${stderr || '(none)'}`);
    }

    // 2. custom-format magic — a plain-SQL dump (wrong binary / -Fc ignored) fails here
    const head = await this.readHead(outputFilePath, PGDMP_MAGIC.length);
    if (head !== PGDMP_MAGIC) {
      throw new Error(
        `pg_dump (${this.binHint(pgDumpBin)}) did NOT produce a custom-format archive — the file starts with ` +
          `${JSON.stringify(head)} instead of "PGDMP". This is almost always the wrong pg_dump binary (a plain-text ` +
          `or pg_dumpall output). ${stderr ? `stderr: ${stderr}` : ''}`,
      );
    }

    // 3. definitive check: pg_restore --list must parse it
    const structural = await this.verifyDumpStructure(outputFilePath);
    if (!structural.ok) {
      throw new Error(`pg_dump produced a file that pg_restore --list cannot parse: ${structural.detail}`);
    }
  }

  private async readHead(filePath: string, n: number): Promise<string> {
    const fh = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return buf.subarray(0, bytesRead).toString('latin1');
    } finally {
      await fh.close();
    }
  }

  /**
   * Read-only structural check — `pg_restore --list` parses the dump's
   * table-of-contents without ever connecting to any database or writing
   * anything. This is the "controlled restore verification mechanism"
   * `BackupManagerService.verifyBackup` uses to confirm a dump is more
   * than just a same-sized file — real proof the archive is internally
   * well-formed, without the cost/risk of a real restore.
   *
   * Returns `{ ok, detail }` (was `Promise<boolean>` before the Backup Gate
   * Fix) so callers can record the ACTUAL `pg_restore` message on the
   * artifact instead of a generic "not structurally valid".
   *
   * The signal is the EXIT CODE: `pg_restore --list` exits non-zero (→
   * `execFileAsync` rejects) if and only if it cannot parse the archive.
   * A clean resolve == valid, regardless of whether stdout was captured —
   * stdout is only used for the human-readable entry count. (Earlier this
   * did `stdout.split(...)` unconditionally and crashed with
   * `Cannot read properties of undefined (reading 'split')` when a
   * CloudLinux `pg_restore` shim resolved with a non-string stdout on exit
   * 0, wrongly failing a valid dump — 2026-08-31.)
   */
  async verifyDumpStructure(filePath: string): Promise<DumpVerifyResult> {
    const { pgRestoreBin } = this.config.releaseBackup;
    try {
      const raw = await execFileAsync(pgRestoreBin, ['--list', filePath], {
        timeout: RESTORE_LIST_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const stdout = asText(raw?.stdout);
      const entries = stdout ? stdout.split('\n').filter((l) => /^\s*\d+;/.test(l)).length : null;
      return {
        ok: true,
        detail:
          entries === null
            ? 'pg_restore --list exited 0 (archive is parseable; table-of-contents not captured)'
            : `${entries} table-of-contents entr${entries === 1 ? 'y' : 'ies'}`,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: unknown };
      const detail = asText(e?.stderr).trim() || (err instanceof Error ? err.message : String(err));
      this.logger.warn(`pg_restore --list failed for "${filePath}" via ${this.binHint(pgRestoreBin)}: ${detail}`);
      return { ok: false, detail: `pg_restore --list (${this.binHint(pgRestoreBin)}): ${detail}` };
    }
  }

  /**
   * Release Center — Phase B (Restore). `--clean --if-exists` drops each
   * object before recreating it (the standard, documented way to restore
   * a custom-format dump ON TOP of an existing database with the same
   * schema, rather than requiring a pre-emptied target) — never `DROP
   * DATABASE`/`CREATE DATABASE`, so the connection/role/grants on the
   * target database are untouched. Same argument-array + `PGPASSWORD`-via-
   * env discipline as `dump()`. Callers MUST take their own safety backup
   * before calling this — this method has no opinion about that, it only
   * runs the restore itself (see `RestoreManagerService.confirmAndRestore`).
   */
  async restore(db: DatabaseConfig, dumpFilePath: string): Promise<void> {
    const { pgRestoreBin } = this.config.releaseBackup;
    const args = [
      '--host', db.host,
      '--port', String(db.port),
      '--username', db.username,
      '--no-password',
      '--dbname', db.database,
      '--clean', '--if-exists',
      dumpFilePath,
    ];
    try {
      await execFileAsync(pgRestoreBin, args, {
        env: { ...process.env, PGPASSWORD: db.password },
        timeout: RESTORE_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: unknown };
      this.logger.error(`pg_restore failed for database "${db.database}"`, e.stack ?? String(err));
      const detail = asText(e?.stderr).trim() || (err instanceof Error ? err.message : String(err));
      throw new Error(`pg_restore (${this.binHint(pgRestoreBin)}) failed: ${detail}`);
    }
  }
}
