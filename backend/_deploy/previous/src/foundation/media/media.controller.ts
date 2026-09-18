import { BadRequestException, Controller, Get, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { MediaService } from './media.service';
import { JwtAuthGuard, AuthenticatedRequest } from '../authentication/jwt-auth.guard';

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
  constructor(private readonly media: MediaService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(@Req() req: AuthenticatedRequest, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded.');
    const asset = await this.media.upload(file.buffer, file.originalname, file.mimetype, req.user.id);
    return { id: asset.id, originalFilename: asset.originalFilename, contentType: asset.contentType, sizeBytes: asset.sizeBytes };
  }

  /** Plain @Res() — bypasses ResponseEnvelopeInterceptor, the established escape hatch for any binary download (see ProductsController.importTemplate). */
  @Get(':id')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { asset, data } = await this.media.download(id);
    res.set({ 'Content-Type': asset.contentType, 'Content-Disposition': `inline; filename="${asset.originalFilename}"` }).send(data);
  }
}
