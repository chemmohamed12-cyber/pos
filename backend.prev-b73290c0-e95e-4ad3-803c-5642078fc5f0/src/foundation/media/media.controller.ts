import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { MediaService } from './media.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';
import { AuthorizationService } from '../authorization/authorization.service';
import { validateMediaUpload } from './media-file-validation';

/**
 * File-handling sweep finding (2026-09-07, LOW): `asset.originalFilename`
 * is attacker-controlled at upload time (whatever the client's multipart
 * form sends) and was interpolated straight into the `Content-Disposition`
 * header's quoted `filename` parameter with no escaping — Node's http
 * layer rejects raw CR/LF in a header value (blocks classic response-
 * splitting), but an embedded `"` still breaks the quoting and could
 * confuse a browser's filename parsing. Strips control characters and
 * escapes `"`/`\` per RFC 6266's quoted-string rules — the same
 * "sanitize what an attacker chose, not just what they can't do" discipline
 * every other user-controlled-string-into-a-header path in this codebase
 * follows.
 */
export function sanitizeForContentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex
  return filename.replace(/[\x00-\x1f\x7f]/g, '').replace(/([\\"])/g, '\\$1');
}

/**
 * Generic authenticated upload endpoint — didn't exist before (every
 * prior upload need went through a feature-specific Excel-import route).
 * The Deposit receipt-image upload (Sales Order Create's Treasury
 * section) is the first caller: any authenticated user (a rep uploading
 * their own customer's transfer receipt) may upload, matching
 * `evidenceMediaAssetId`'s existing "any submitter" reach on
 * `POST /deposits` — no role gate beyond being logged in.
 */
@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly authorization: AuthorizationService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(@Req() req: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded.');
    // Security fix F1 (2026-09-06): validated allow-list + magic-byte check,
    // not the client-supplied mimetype string alone — see media-file-validation.ts.
    const verifiedMimetype = validateMediaUpload(file.buffer, file.originalname, file.mimetype);
    const asset = await this.media.upload(file.buffer, file.originalname, verifiedMimetype, req.user.id);
    return { id: asset.id, originalFilename: asset.originalFilename, contentType: asset.contentType, sizeBytes: asset.sizeBytes };
  }

  /**
   * Commercial Release Gate finding SEC-12 (red-team RT12 — unknown-path
   * challenge, live-confirmed): this route carried authentication only —
   * ANY authenticated user could download ANY uploaded file by id, no
   * ownership check at all. `evidenceMediaAssetId`/`waybillImageMediaAssetId`
   * consumers (deposit receipts, waybill photos) are business records this
   * service doesn't yet know how to scope-check (that's ADR-031's
   * scope-derivation layer, not built yet — deliberately not solved here
   * with a second, competing bespoke rule).
   *
   * Interim fix, safe and non-breaking: the uploader can always see their
   * own upload (unchanged for every legitimate single-user flow so far);
   * an admin can see everything (unchanged — admins already bypass Scope
   * everywhere). Anyone ELSE is denied with a 404 (anti-enumeration,
   * ADR-005), not a 403 — this route must not confirm an asset id exists to
   * a caller who has no right to it. **Known, disclosed limitation**: a
   * legitimate finance reviewer who did NOT upload a given receipt image
   * cannot currently view it either — narrower than intended, but strictly
   * safer than the finding it replaces. Widen this once ADR-031 ships and
   * media can derive scope from its owning business record correctly,
   * rather than approximating it here.
   *
   * Plain @Res() — bypasses ResponseEnvelopeInterceptor, the established
   * escape hatch for any binary download (see ProductsController.importTemplate).
   */
  @Get(':id')
  async download(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { asset, data } = await this.media.download(id);
    if (asset.uploadedByUserId !== req.user.id) {
      const roles = await this.authorization.getRoleKeysForUser(req.user.id);
      if (!roles.includes('admin')) throw new NotFoundException(); // 404, not 403 — anti-enumeration (ADR-005), matches ScopeService.assertAccess's own convention
    }
    // Security fix F1 (2026-09-06): asset.contentType is now guaranteed to be
    // one of ALLOWED_MEDIA_TYPES (validated at upload time above), so serving
    // it `inline` can no longer render as executable/script content — but
    // `nosniff` is kept as a defense-in-depth line item pending the broader
    // security-headers gap (Finding F2) being addressed separately.
    res
      .set({
        'Content-Type': asset.contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${sanitizeForContentDisposition(asset.originalFilename)}"`,
      })
      .send(data);
  }
}
