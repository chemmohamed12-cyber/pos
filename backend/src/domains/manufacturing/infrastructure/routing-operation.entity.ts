import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** ADR-061 Addendum 1 (A1) — one operation of a routing: ordered by `sequence`, performed at `workCenterId`. */
@Entity('routing_operations')
@Index(['routingId', 'sequence'], { unique: true })
export class RoutingOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  routingId!: string;

  @Column({ type: 'int' })
  sequence!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description!: string | null;

  @Index()
  @Column('uuid')
  workCenterId!: string;
}
