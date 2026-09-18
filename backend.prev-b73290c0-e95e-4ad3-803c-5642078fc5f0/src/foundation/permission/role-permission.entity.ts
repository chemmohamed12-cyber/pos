import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type PermissionAccess = 'hidden' | 'read-only' | 'editable';

/**
 * Permission Engine — Stage 2 build-order item 8.
 * Daii/architecture/DAII_PLATFORM_FOUNDATION_CONTRACT.md §4, ADR-005.
 * Pattern adapted from xnexus-website's permission-engine.js (Class C,
 * Daii/_source-audits/xnexus-website/) — hierarchical deny-by-default
 * node resolution, ancestor-walk inheritance — with the per-user-role
 * dimension added that the source lacked (it resolved per-tenant only).
 *
 * `nodeKey` is a dotted path (e.g. "sales_orders.approve") rather than a
 * separate pre-registered node-tree table — deliberate V1 simplification
 * (CTO Execution Policy §3/§4: no unnecessary abstraction). Deny-by-default
 * falls out naturally: no row for a role+node = hidden, no registry to
 * keep in sync.
 */
@Entity('role_permissions')
@Index(['roleId', 'nodeKey'], { unique: true })
export class RolePermission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  roleId!: string;

  @Column({ type: 'varchar', length: 255 })
  nodeKey!: string;

  @Column({ type: 'varchar', length: 16 })
  access!: PermissionAccess;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
