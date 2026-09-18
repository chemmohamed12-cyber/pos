import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { ObjectStoragePort, StoredObject } from './object-storage.port';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * File / Media Abstraction — Stage 2 build-order item 19.
 *
 * The Cloud/On-Premise/LAN port-and-adapter pattern (ADR-019) in its
 * simplest concrete form: local disk. Doubles as the actual On-Premise/
 * LAN adapter named in the port catalog — not a throwaway V1-only
 * shortcut.
 */
@Injectable()
export class LocalFilesystemStorageAdapter implements ObjectStoragePort {
  private readonly basePath: string;

  constructor(config: AppConfigService) {
    this.basePath = resolve(config.mediaStoragePath);
  }

  private pathFor(key: string): string {
    // Reject any key that could escape basePath via ../ traversal.
    const target = resolve(this.basePath, key);
    if (!target.startsWith(this.basePath)) {
      throw new Error(`Invalid storage key "${key}" — path traversal is not permitted.`);
    }
    return target;
  }

  // contentType is part of the port contract (a cloud adapter needs it for the
  // object's Content-Type header) but local disk has no equivalent concept —
  // MediaService already persists it in MediaAsset's own metadata row.
  async save(key: string, data: Buffer, _contentType: string): Promise<StoredObject> {
    const filePath = this.pathFor(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return { key, url: `/media/${key}` };
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export function joinKey(...parts: string[]): string {
  return join(...parts).replace(/\\/g, '/');
}
