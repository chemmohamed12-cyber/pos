import { CORE_COMPANY_ENTITIES } from '../company/core-company-entities';
import { ACCOUNTING_COMPANY_ENTITIES } from '../../domains/accounting/accounting-company-entities';
import { CUSTOMER_FINANCE_COMPANY_ENTITIES } from '../../domains/customer-finance/customer-finance-company-entities';
import { TREASURY_COMPANY_ENTITIES } from '../../domains/treasury/treasury-company-entities';
import { INVENTORY_VALUATION_COMPANY_ENTITIES } from '../../domains/inventory-valuation/inventory-valuation-company-entities';
import { INVENTORY_WAREHOUSE_COMPANY_ENTITIES } from '../../domains/inventory-warehouse/inventory-warehouse-company-entities';
import { PROCUREMENT_COMPANY_ENTITIES } from '../../domains/procurement/procurement-company-entities';
import { SALES_ORDERS_COMPANY_ENTITIES } from '../../domains/sales-orders/sales-orders-company-entities';
import { SHIPMENT_COMPANY_ENTITIES } from '../../domains/shipment/shipment-company-entities';
import { RETURNS_COMPANY_ENTITIES } from '../../domains/returns/returns-company-entities';
import { COMMERCE_COMPANY_ENTITIES } from '../../domains/commerce/commerce-company-entities';
import { CRM_COMPANY_ENTITIES } from '../../domains/crm/crm-company-entities';
import { FULFILLMENT_COMPANY_ENTITIES } from '../../domains/fulfillment/fulfillment-company-entities';
import { DELIVERY_COMPANY_ENTITIES } from '../../domains/delivery/delivery-company-entities';
import { DEPOSIT_CONTROL_COMPANY_ENTITIES } from '../../domains/deposit-control/deposit-control-company-entities';
import { MANUFACTURING_COMPANY_ENTITIES } from '../../domains/manufacturing/manufacturing-company-entities';
import { HR_COMPANY_ENTITIES } from '../../domains/hr/hr-company-entities';
import { TARGETS_COMPANY_ENTITIES } from '../../domains/targets/targets-company-entities';

import { ATTENDANCE_COMPANY_ENTITIES } from '../../domains/attendance/attendance-company-entities';

import { COMMISSION_COMPANY_ENTITIES } from '../../domains/commission/commission-company-entities';

import { PAYROLL_COMPANY_ENTITIES } from '../../domains/payroll/payroll-company-entities';

import { SALES_COMPANY_ENTITIES } from '../../domains/sales/sales-company-entities';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B — Domain-Owned Company
 * Entity Sets + Single Aggregated Company Entity Registry). Each domain
 * owns and reviews its own Company-connection-capable entity list,
 * alongside its own code; this file only aggregates them into the single
 * list `createCompanyDataSource()` needs. Adding a new Company entity
 * means adding it to the OWNING domain's own `*-company-entities.ts` file
 * (creating one, per this same pattern, if the domain doesn't have one
 * yet) — never editing a giant list here by hand.
 *
 * Deliberately does NOT restructure `CompanyConnectionManagerService`'s
 * existing single-cached-`DataSource`-per-Company model (ADR-074 §8's own
 * explicit constraint) — every domain's entities are registered on the
 * SAME one connection, not a separate DataSource per domain.
 *
 * `company-entity-registry.completeness.spec.ts` is the guard against
 * this list silently falling behind a domain service that starts using a
 * new Company-scoped entity without adding it to its own manifest file —
 * the exact failure shape ADR-074 traced back to the pre-existing
 * migration-tag incident this decision was made specifically to avoid
 * repeating.
 */
export const COMPANY_ENTITY_REGISTRY = [
  ...CORE_COMPANY_ENTITIES,
  ...ACCOUNTING_COMPANY_ENTITIES,
  ...CUSTOMER_FINANCE_COMPANY_ENTITIES,
  ...TREASURY_COMPANY_ENTITIES,
  ...INVENTORY_VALUATION_COMPANY_ENTITIES,
  ...INVENTORY_WAREHOUSE_COMPANY_ENTITIES,
  ...PROCUREMENT_COMPANY_ENTITIES,
  ...SALES_ORDERS_COMPANY_ENTITIES,
  ...SHIPMENT_COMPANY_ENTITIES,
  ...RETURNS_COMPANY_ENTITIES,
  ...COMMERCE_COMPANY_ENTITIES,
  ...CRM_COMPANY_ENTITIES,
  ...FULFILLMENT_COMPANY_ENTITIES,
  ...DELIVERY_COMPANY_ENTITIES,
  ...DEPOSIT_CONTROL_COMPANY_ENTITIES,
  ...MANUFACTURING_COMPANY_ENTITIES,
  ...HR_COMPANY_ENTITIES,
  ...TARGETS_COMPANY_ENTITIES,
  ...ATTENDANCE_COMPANY_ENTITIES,
  ...COMMISSION_COMPANY_ENTITIES,
  ...PAYROLL_COMPANY_ENTITIES,
  ...SALES_COMPANY_ENTITIES,
];
