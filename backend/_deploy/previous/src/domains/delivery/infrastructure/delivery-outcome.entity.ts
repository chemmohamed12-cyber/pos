import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DeliveryOutcomeType } from '../domain/delivery-outcome-type';

/**
 * Richer detail than Shipment's own state (delivered/failed/returned) —
 * carries the failure reason blueprint §28 asks for ("Was it returned?
 * If not, why?"). Delivery drives Shipment's transition through its
 * published contract (ShipmentService.transitionShipment), never
 * touching the shipments table directly (Cross-Domain Rule).
 */
@Entity('delivery_outcomes')
export class DeliveryOutcome {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  shipmentId!: string;

  @Column({ type: 'varchar', length: 16 })
  outcome!: DeliveryOutcomeType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  failureReason!: string | null;

  @Column('uuid')
  recordedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt!: Date;
}
