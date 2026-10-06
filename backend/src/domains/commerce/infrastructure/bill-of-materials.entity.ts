import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Gap G-2 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §3B/§4,
 * §21 — CTO handover directive §15: "BOM -> Components -> Assembly ->
 * Component Consumption -> Finished Goods. Do NOT build a full MRP/
 * manufacturing ERP now."). One BOM per finished product (V1 simplicity —
 * no versioning, no effective-date ranges, no alternate/optional
 * components): the recipe a `finishedProductId` is assembled from, owned
 * by Commerce (`DAII_DOMAIN_BOUNDARIES.md` §1 — Commerce defines product
 * structure; Inventory/Warehouse consumes it as a published read to
 * perform the actual stock movements).
 */
/** ADR-061 Addendum 1 (A2) — BOM lifecycle status. `inactive` = not usable for new Work Orders / assemblies; released Work Orders are unaffected (they snapshot their components). */
export type BomStatus = 'active' | 'inactive';

@Entity('bill_of_materials')
export class BillOfMaterial {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column('uuid')
  finishedProductId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: BomStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
