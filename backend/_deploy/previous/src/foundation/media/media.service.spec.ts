import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaAsset } from './media-asset.entity';
import { OBJECT_STORAGE_PORT, ObjectStoragePort } from './object-storage.port';

describe('MediaService', () => {
  let service: MediaService;
  const files = new Map<string, Buffer>();

  const storageMock: ObjectStoragePort = {
    save: jest.fn(async (key: string, data: Buffer) => {
      files.set(key, data);
      return { key, url: `/media/${key}` };
    }),
    read: jest.fn(async (key: string) => files.get(key)!),
    delete: jest.fn(async (key: string) => {
      files.delete(key);
    }),
  };

  const assetsStore = new Map<string, MediaAsset>();
  const assetRepoMock = {
    create: jest.fn((data: Partial<MediaAsset>) => ({ id: `asset-${assetsStore.size + 1}`, ...data }) as MediaAsset),
    save: jest.fn(async (a: MediaAsset) => {
      assetsStore.set(a.id, a);
      return a;
    }),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) => assetsStore.get(where.id) ?? null),
    remove: jest.fn(async (a: MediaAsset) => {
      assetsStore.delete(a.id);
    }),
  };

  beforeEach(async () => {
    files.clear();
    assetsStore.clear();
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: OBJECT_STORAGE_PORT, useValue: storageMock },
        { provide: getRepositoryToken(MediaAsset), useValue: assetRepoMock },
      ],
    }).compile();
    service = moduleRef.get(MediaService);
  });

  it('uploads a file and records its metadata', async () => {
    const asset = await service.upload(Buffer.from('content'), 'evidence.png', 'image/png', 'user-1');
    expect(asset.originalFilename).toBe('evidence.png');
    expect(asset.sizeBytes).toBe(7);
    expect(asset.uploadedByUserId).toBe('user-1');
  });

  it('downloads a previously uploaded file', async () => {
    const asset = await service.upload(Buffer.from('deposit evidence'), 'proof.jpg', 'image/jpeg', 'user-1');
    const result = await service.download(asset.id);
    expect(result.data.toString()).toBe('deposit evidence');
  });

  it('throws when downloading an unknown asset id', async () => {
    await expect(service.download('no-such-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes both the storage object and the metadata row', async () => {
    const asset = await service.upload(Buffer.from('x'), 'f.txt', 'text/plain', null);
    await service.remove(asset.id);
    expect(assetsStore.has(asset.id)).toBe(false);
    await expect(service.download(asset.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
