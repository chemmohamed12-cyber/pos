/**
 * File / Media Abstraction — Stage 2 build-order item 19.
 * Daii/architecture/DAII_INFRASTRUCTURE_ABSTRACTION.md §2, ADR-019.
 *
 * The port every Foundation/Domain capability depends on — never a
 * specific cloud SDK (S3, etc.) imported directly. Exactly one adapter
 * ships in V1 (LocalFilesystemStorageAdapter — also the documented
 * On-Premise/LAN adapter for this same port, so this is real
 * dual-purpose work, not throwaway scaffolding). An S3-compatible cloud
 * adapter implements this same interface later without any consumer
 * changing (ADR-016: L3 contract now, L2 coverage — one adapter — today).
 */
export interface StoredObject {
  key: string;
  url: string;
}

export interface ObjectStoragePort {
  save(key: string, data: Buffer, contentType: string): Promise<StoredObject>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const OBJECT_STORAGE_PORT = Symbol('OBJECT_STORAGE_PORT');
