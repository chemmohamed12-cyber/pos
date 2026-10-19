import { Controller, Post, UploadedFile, UseInterceptors, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest');
import { readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { ReleaseUploadInterceptor } from './release-upload.interceptor';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * Release Center upload over real HTTP (multipart, multer, the real interceptor) with a tiny test controller: no database, no release is registered, no deployment. Proves the configured
 * cap is enforced by the STREAM (not only by the Content-Length header), the refusal is a 413 naming the setting, and no temp file is left behind on a refusal or after handling.
 */
@Controller('t')
class UploadProbeController {
  @Post('upload')
  @UseInterceptors(ReleaseUploadInterceptor)
  upload(@UploadedFile() file: Express.Multer.File) {
    const size = readFileSync(file.path).length;
    rmSync(file.path, { force: true }); // what the real controller does in its finally block
    return { size };
  }
}

describe('Release Center upload over HTTP - RELEASE_UPLOAD_MAX_MB', () => {
  let app: INestApplication;
  const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith('release-upload-')).length;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [UploadProbeController],
      providers: [ReleaseUploadInterceptor, { provide: AppConfigService, useValue: { releaseUploadMaxBytes: 2 * 1024 * 1024 } }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('a file within the 2 MB test cap is accepted and its temp file is removed', async () => {
    const before = leftovers();
    const res = await request(app.getHttpServer()).post('/t/upload').attach('file', Buffer.alloc(1024 * 1024, 1), 'ok.zip');
    expect([res.status, res.body.size]).toEqual([201, 1024 * 1024]);
    expect(leftovers()).toBe(before);
  });

  it('a file above the cap is a 413 naming the cap and the setting, and leaves no temp file', async () => {
    const before = leftovers();
    const res = await request(app.getHttpServer()).post('/t/upload').attach('file', Buffer.alloc(3 * 1024 * 1024, 1), 'big.zip');
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).toMatch(/2 MB \(RELEASE_UPLOAD_MAX_MB\)/);
    expect(leftovers()).toBe(before);
  });

  it('a chunked upload (no Content-Length) above the cap is stopped by the stream limit itself', async () => {
    const before = leftovers();
    let refused = false;
    try {
      const res = await request(app.getHttpServer())
        .post('/t/upload')
        .set('Transfer-Encoding', 'chunked')
        .attach('file', Buffer.alloc(3 * 1024 * 1024, 1), 'chunked.zip');
      refused = [413, 400].includes(res.status);
    } catch (err) {
      // multer stops reading at the cap and the server may reset the connection before the client has finished sending - that is also a refusal, not an accepted upload
      refused = ['ECONNRESET', 'EPIPE'].includes((err as NodeJS.ErrnoException).code ?? '');
    }
    expect(refused).toBe(true);
    expect(leftovers()).toBe(before);
  });
});
