import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { MediaAsset } from './media-asset.entity';
import { OBJECT_STORAGE_PORT, ObjectStoragePort } from './object-storage.port';

/**
 * File / Media Abstraction — Stage 2 build-order item 19 / Foundation
 * Contract §15. Depends only on the port (OBJECT_STORAGE_PORT token),
 * never the concrete adapter — swapping LocalFilesystemStorageAdapter
 * for a future S3 adapter requires no change here.
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
    @InjectRepository(MediaAsset) private readonly assets: Repository<MediaAsset>,
  ) {}

  async upload(
    data: Buffer,
    originalFilename: string,
    contentType: string,
    uploadedByUserId: string | null,
  ): Promise<MediaAsset> {
    const key = `${randomUUID()}-${originalFilename}`;
    await this.storage.save(key, data, contentType);
    return this.assets.save(
      this.assets.create({
        storageKey: key,
        originalFilename,
        contentType,
        sizeBytes: data.byteLength,
        uploadedByUserId,
      }),
    );
  }

  async download(assetId: string): Promise<{ asset: MediaAsset; data: Buffer }> {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Media asset "${assetId}" not found.`);
    const data = await this.storage.read(asset.storageKey);
    return { asset, data };
  }

  async remove(assetId: string): Promise<void> {
    const asset = await this.assets.findOne({ where: { id: assetId } });
    if (!asset) return;
    await this.storage.delete(asset.storageKey);
    await this.assets.remove(asset);
  }
}
