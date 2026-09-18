import { BadRequestException } from '@nestjs/common';

/**
 * Security fix — F1 (Team B Security Baseline Audit, 2026-09-06, P1/P2).
 *
 * The generic /media upload had no extension/MIME/content allow-list: any
 * authenticated user could upload a file claiming `mimetype: text/html` (or
 * `image/svg+xml`, which can embed <script>), which was then served back on
 * GET /media/:id with that same attacker-controlled Content-Type and
 * `Content-Disposition: inline` — a same-origin stored-XSS path reachable by
 * any authenticated account regardless of role (SECURE_CODING_STANDARD.md
 * §10). This module is the narrow, non-architectural fix: allow-list the
 * realistic receipt-evidence types (image + PDF) and verify the file's
 * actual leading bytes match the claimed type — not just the client-
 * supplied `mimetype` string, which is trivially spoofable.
 *
 * No new dependency added (Team B DEPENDENCY_SECURITY_POLICY.md would
 * require a review for that) — magic-byte signatures for this small,
 * fixed set of types are simple enough to check directly.
 */

export interface AllowedMediaType {
  mimetype: string;
  extensions: string[];
  /** Returns true if `buf`'s leading bytes match this type's known signature. */
  matchesSignature: (buf: Buffer) => boolean;
}

export const ALLOWED_MEDIA_TYPES: AllowedMediaType[] = [
  {
    mimetype: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    matchesSignature: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mimetype: 'image/png',
    extensions: ['.png'],
    matchesSignature: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    mimetype: 'image/gif',
    extensions: ['.gif'],
    matchesSignature: (buf) =>
      buf.length >= 6 &&
      buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a',
  },
  {
    mimetype: 'image/webp',
    extensions: ['.webp'],
    matchesSignature: (buf) =>
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mimetype: 'application/pdf',
    extensions: ['.pdf'],
    matchesSignature: (buf) => buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-',
  },
];

const ALLOWED_MIMETYPES = new Set(ALLOWED_MEDIA_TYPES.map((t) => t.mimetype));

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

/**
 * Throws BadRequestException unless the upload passes all three checks:
 * claimed MIME type is allow-listed, filename extension matches that type,
 * and the buffer's actual magic bytes match that type. Returns the
 * validated, canonical MIME type to persist (never trust the client's
 * string past this point beyond having matched the allow-list).
 */
export function validateMediaUpload(buffer: Buffer, originalFilename: string, claimedMimetype: string): string {
  if (!ALLOWED_MIMETYPES.has(claimedMimetype)) {
    throw new BadRequestException(
      `File type "${claimedMimetype}" is not allowed. Allowed types: ${[...ALLOWED_MIMETYPES].join(', ')}.`,
    );
  }
  const type = ALLOWED_MEDIA_TYPES.find((t) => t.mimetype === claimedMimetype)!;
  const ext = extensionOf(originalFilename);
  if (!type.extensions.includes(ext)) {
    throw new BadRequestException(`File extension "${ext}" does not match declared type "${claimedMimetype}".`);
  }
  if (!type.matchesSignature(buffer)) {
    throw new BadRequestException('File content does not match its declared type (failed signature check).');
  }
  return type.mimetype;
}
