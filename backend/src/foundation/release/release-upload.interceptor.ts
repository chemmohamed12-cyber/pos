import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { statfs } from 'fs/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import type { Observable } from 'rxjs';
import { AppConfigService } from '../configuration/app-config.service';

/** Space that must remain on the temp volume after the declared upload has been written (the validator extracts into the staging path, not here). */
const TEMP_HEADROOM_BYTES = 100 * 1024 * 1024;

/**
 * Release Center ZIP upload: the multipart size cap comes from `RELEASE_UPLOAD_MAX_MB` (default 200 = the former hard-coded value), read per request. Two precise refusals replace the generic
 * failures: an upload above the cap is a 413 that names the cap and the setting; a temp volume without room for the declared size is a 507 that names the volume. The ZIP is still written to
 * the OS temp directory (moving it is a separate review) and removed by the controller / multer on every failure path. Package validation (integrity, manifest, checksums) is untouched.
 */
@Injectable()
export class ReleaseUploadInterceptor implements NestInterceptor {
  constructor(private readonly config: AppConfigService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const maxBytes = this.config.releaseUploadMaxBytes;
    const maxMb = Math.round(maxBytes / 1024 / 1024);
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > 0) {
      if (declared > maxBytes + 1024 * 1024) {
        throw new PayloadTooLargeException(`The release package is larger than the configured limit of ${maxMb} MB (RELEASE_UPLOAD_MAX_MB).`);
      }
      try {
        const s = await statfs(tmpdir());
        const free = s.bavail * s.bsize;
        if (free < declared + TEMP_HEADROOM_BYTES) {
          throw new HttpException(`The temporary volume has ${(free / 1024 / 1024).toFixed(0)} MB free; this upload needs about ${((declared + TEMP_HEADROOM_BYTES) / 1024 / 1024).toFixed(0)} MB. Free space on the temp volume and retry.`, 507);
        }
      } catch (err) {
        if (err instanceof HttpException) throw err; // a statfs failure is not a reason to refuse an upload
      }
    }

    const Interceptor = FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir(), filename: (_req, _file, cb) => cb(null, `release-upload-${randomUUID()}.zip`) }),
      limits: { fileSize: maxBytes },
    });
    try {
      return await new Interceptor().intercept(context, next);
    } catch (err) {
      if (err instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException(`The release package is larger than the configured limit of ${maxMb} MB (RELEASE_UPLOAD_MAX_MB).`);
      }
      throw err;
    }
  }
}
