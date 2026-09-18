import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * External Integrations — CTO directive §8 ("never match products only
 * by display name... explicit integration mapping: Daii Product UUID +
 * SKU <-> QR Product ID"). One row per (connector, Daii product);
 * `externalProductId` is whatever opaque identifier the external system
 * uses for the matching record. Survives name/price/image/description
 * changes on either side because nothing here derives from those fields.
 */
@Entity('integration_product_mappings')
@Index(['connectorId', 'daiiProductId'], { unique: true })
@Index(['connectorId', 'externalProductId'], { unique: true })
export class IntegrationProductMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  connectorId!: string;

  @Column('uuid')
  daiiProductId!: string;

  @Column({ type: 'varchar', length: 128 })
  externalProductId!: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
