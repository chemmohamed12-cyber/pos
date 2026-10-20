import { BadRequestException } from '@nestjs/common';
import { PRODUCT_IMAGE_MAX_BYTES, ProductImageService } from './product-image.service';
import { ObjectStoragePort } from '../../../foundation/media/object-storage.port';

/** Database-free: an in-memory storage port. The Company id is part of the storage key, so one Company can never read another's item image. */
describe('ProductImageService', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const P = '33333333-3333-4333-8333-333333333333';
  const make = () => {
    const files = new Map<string, Buffer>();
    const port: ObjectStoragePort = {
      save: async (key, data) => (files.set(key, data), { key, url: key }),
      read: async (key) => {
        const v = files.get(key);
        if (!v) throw new Error('ENOENT');
        return v;
      },
      delete: async (key) => void files.delete(key),
    };
    return { files, svc: new ProductImageService(port) };
  };

  it('saves a PNG and reads it back with its type; no image reads as null', async () => {
    const { svc } = make();
    expect(await svc.read(A, P)).toBeNull();
    expect((await svc.save(A, P, PNG, 'x.png', 'image/png')).contentType).toBe('image/png');
    const r = await svc.read(A, P);
    expect([r?.contentType, r?.data.equals(PNG)]).toEqual(['image/png', true]);
  });

  it('a new image of another type REPLACES the old one (one image per item)', async () => {
    const { svc, files } = make();
    await svc.save(A, P, PNG, 'x.png', 'image/png');
    await svc.save(A, P, JPEG, 'y.jpg', 'image/jpeg');
    expect([...files.keys()]).toEqual([`product-images/${A}/${P}.jpg`]);
    expect((await svc.read(A, P))?.contentType).toBe('image/jpeg');
  });

  it('refuses a PDF, a spoofed type (claims PNG, is not), and an oversize file - nothing is stored', async () => {
    const { svc, files } = make();
    await expect(svc.save(A, P, Buffer.from('%PDF-1.4 ....'), 'a.pdf', 'application/pdf')).rejects.toThrow(BadRequestException);
    await expect(svc.save(A, P, Buffer.from('<html>not an image</html>'), 'a.png', 'image/png')).rejects.toThrow(BadRequestException);
    await expect(svc.save(A, P, Buffer.alloc(PRODUCT_IMAGE_MAX_BYTES + 1, 1), 'a.png', 'image/png')).rejects.toThrow(/larger than/);
    expect(files.size).toBe(0);
  });

  it('is isolated per Company (the key carries the Company) and remove deletes the image', async () => {
    const { svc } = make();
    await svc.save(A, P, PNG, 'x.png', 'image/png');
    expect(await svc.read(B, P)).toBeNull();
    await svc.remove(A, P);
    expect(await svc.read(A, P)).toBeNull();
  });
});
