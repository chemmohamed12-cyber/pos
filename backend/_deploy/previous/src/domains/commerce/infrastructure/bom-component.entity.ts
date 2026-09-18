import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One component line of a BOM (Gap G-2) — how many units of `componentProductId` build ONE unit of the BOM's finished product. */
@Entity('bom_components')
@Index(['billOfMaterialId', 'componentProductId'], { unique: true })
export class BomComponent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  billOfMaterialId!: string;

  @Column('uuid')
  componentProductId!: string;

  @Column({ type: 'int' })
  quantityPerUnit!: number;
}
