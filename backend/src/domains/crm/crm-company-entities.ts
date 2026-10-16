import { Customer } from './infrastructure/customer.entity';
import { CustomerAssignment } from './infrastructure/customer-assignment.entity';
import { CustomerAddress } from './infrastructure/customer-address.entity';
import { CustomerContact } from './infrastructure/customer-contact.entity';

/**
 * ADR-074 (2026-09-25, CTO Decision: Hybrid B). CRM's own
 * Company-connection-capable entities — added 2026-09-27 (Area 21
 * Operational Company Scoping Retrofit) when `CustomersService.getWorkflowPolicySnapshot`/
 * `getPriceListId`/`getCustomerSnapshot` became `manager?`-capable
 * (needed by `SalesOrdersService.createOrder`/`editDraftOrder`/
 * `getOrderDetailView`'s own retrofit). `CustomerAssignment` included
 * alongside `Customer` — same domain, same completeness-scan finding.
 */
export const CRM_COMPANY_ENTITIES = [Customer, CustomerAssignment, CustomerAddress, CustomerContact];
