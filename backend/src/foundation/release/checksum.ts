import { createHash } from 'crypto';
import { createReadStream } from 'fs';

/** SHA-256 of a file's contents, streamed (never loads the whole file into memory — matters for potentially large backup archives). Shared by `BackupManagerService` (recording/verifying) and `RestoreManagerService` (re-verifying before a restore actually runs). */
export function computeFileChecksum(absolutePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** SHA-256 of a plain string — `ReleaseManagerService` uses this on the manifest's own JSON so a stored release can later prove its manifest hasn't been altered since registration. */
export function computeStringChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
