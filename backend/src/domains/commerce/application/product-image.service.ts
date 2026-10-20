import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OBJECT_STORAGE_PORT, ObjectStoragePort } from '../../../foundation/media/object-storage.port';
import { validateMediaUpload } from '../../../foundation/media/media-file-validation';

/** Image types an item may carry (the shared media allow-list minus PDF), by canonical MIME type -> file extension used in the storage key. */
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([type, ext]) => [ext, type]));
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Item image (Item Details). The file lives behind the object-storage port under a key that carries BOTH the Company and the item: `product-images/<companyId>/<productId>.<ext>`,
 * so an item of another Company can never resolve to this file and no schema change is needed (the key is the link). One image per item: saving replaces any earlier one (whatever its
 * type). The upload goes through the same validation as every media upload (allow-list + magic bytes - never the client's claimed type alone), and PDF is refused.
 */
@Injectable()
export class ProductImageService {
  constructor(@Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort) {}

  private key(companyId: string, productId: string, ext: string): string {
    return `product-images/${companyId}/${productId}.${ext}`;
  }

  async save(companyId: string, productId: string, buffer: Buffer, originalFilename: string, claimedMimetype: string): Promise<{ contentType: string; sizeBytes: number }> {
    if (buffer.length > PRODUCT_IMAGE_MAX_BYTES) throw new BadRequestException(`The image is larger than ${PRODUCT_IMAGE_MAX_BYTES / 1024 / 1024} MB.`);
    const contentType = validateMediaUpload(buffer, originalFilename, claimedMimetype);
    const ext = IMAGE_EXTENSIONS[contentType];
    if (!ext) throw new BadRequestException('Only JPEG, PNG, GIF or WebP images are accepted for an item.');
    for (const other of Object.values(IMAGE_EXTENSIONS)) if (other !== ext) await this.storage.delete(this.key(companyId, productId, other));
    await this.storage.save(this.key(companyId, productId, ext), buffer, contentType);
    return { contentType, sizeBytes: buffer.length };
  }

  /** The item's image, or null when it has none. */
  async read(companyId: string, productId: string): Promise<{ data: Buffer; contentType: string } | null> {
    for (const ext of Object.keys(CONTENT_TYPE_BY_EXTENSION)) {
      try {
        return { data: await this.storage.read(this.key(companyId, productId, ext)), contentType: CONTENT_TYPE_BY_EXTENSION[ext] };
      } catch {
        /* not stored under this extension */
      }
    }
    return null;
  }

  async remove(companyId: string, productId: string): Promise<void> {
    for (const ext of Object.values(IMAGE_EXTENSIONS)) await this.storage.delete(this.key(companyId, productId, ext));
  }
}
