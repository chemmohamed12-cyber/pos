import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalFilesystemStorageAdapter } from './local-filesystem-storage.adapter';
import { AppConfigService } from '../configuration/app-config.service';

/**
 * Real filesystem I/O against a temp directory — no database needed, so
 * this is genuine integration-level verification (not mocked), unlike
 * most of this session's DB-dependent milestones.
 */
describe('LocalFilesystemStorageAdapter', () => {
  let tempDir: string;
  let adapter: LocalFilesystemStorageAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'daii-media-test-'));
    const configMock = { mediaStoragePath: tempDir } as AppConfigService;
    adapter = new LocalFilesystemStorageAdapter(configMock);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('saves and reads back the same bytes', async () => {
    const data = Buffer.from('hello daii');
    await adapter.save('test-key.txt', data, 'text/plain');
    const readBack = await adapter.read('test-key.txt');
    expect(readBack.toString()).toBe('hello daii');
  });

  it('creates nested directories for a namespaced key', async () => {
    await adapter.save('deposits/2026/evidence.png', Buffer.from('fake-png'), 'image/png');
    const readBack = await adapter.read('deposits/2026/evidence.png');
    expect(readBack.toString()).toBe('fake-png');
  });

  it('deletes a stored object', async () => {
    await adapter.save('to-delete.txt', Buffer.from('bye'), 'text/plain');
    await adapter.delete('to-delete.txt');
    await expect(adapter.read('to-delete.txt')).rejects.toThrow();
  });

  it('rejects a key attempting path traversal outside the storage root', async () => {
    await expect(adapter.save('../../etc/passwd', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      /path traversal/,
    );
  });
});
