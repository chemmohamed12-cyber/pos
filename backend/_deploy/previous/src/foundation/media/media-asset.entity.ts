import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Metadata only — the file content lives behind ObjectStoragePort, never in this table (DAII_DATA_ARCHITECTURE.md §2). */
@Entity('media_assets')
export class MediaAsset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 512 })
  storageKey!: string;

  @Column({ type: 'varchar', length: 255 })
  originalFilename!: string;

  @Column({ type: 'varchar', length: 128 })
  contentType!: string;

  @Column({ type: 'int' })
  sizeBytes!: number;

  @Column({ type: 'uuid', nullable: true })
  uploadedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
