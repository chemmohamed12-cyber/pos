import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Customer } from '../infrastructure/customer.entity';
import { CustomerAssignment } from '../infrastructure/customer-assignment.entity';
import { canTransitionCustomerStatus, CustomerStatus } from '../domain/customer-status';
import { isValidOrderWorkflowPolicy, OrderWorkflowPolicy } from '../domain/order-workflow-policy';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { CUSTOMER_CODE_KIND, assertEntityCodeFree, issueEntityCode, normalizeEntityCode, peekEntityCode, rethrowDuplicateCode } from '../../../foundation/numbering/entity-code';
import { ScopeService } from '../../../foundation/scope/scope.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { UsersService } from '../../../foundation/identity/users.service';
import { SalesCustomersContract } from '../../../foundation/module-registry/contracts/sales.contract';
import { LimitService } from '../../../foundation/limit-engine/limit.service';

/**
 * Same Scope-vs-Role split documented in
 * `DAII_PLATFORM_FOUNDATION_CONTRACT.md` §5.1: a Sales Order reviewer
 * (supervisor/manager) legitimately needs to see the customer on an
 * order they're reviewing, but Scope's `scope_assignments` are only ever
 * granted to the owning rep — enforcing raw Scope here would 404 every
 * customer for a reviewer. Kept local to this domain (not a change to
 * Scope's global `UNRESTRICTED_ROLES`, which would over-broaden these
 * roles' access to every OTHER scoped resource type, e.g. warehouses).
 *
 * `finance`: REAL BUG FOUND LIVE (Returns/Custody-Settlement E2E
 * verification) — same class of gap as `SalesOrdersService.getOrder`'s
 * already-fixed `task_cf32e266` (that fix's own comment predicted this
 * exact class of bug elsewhere): `finance` is `@RequireRole`-gated onto
 * money-domain routes (invoice creation/posting, AR, Customer Statement,
 * Collection settlement) across this whole codebase, but was never
 * Scope-assigned to individual customers (Scope assignment is a
 * per-sales-rep concept) — so every one of those routes 404'd for a
 * finance user on any customer they weren't individually assigned to,
 * i.e. almost all of them. `getCustomer`, `listCustomers`, and
 * `listCustomersForRep` (via `InvoiceService.createDraftInvoice`,
 * `customer-ledger.controller.ts`'s balances/statement routes, and
 * `CustomerAccountsService`) all gate through this same list — finance
 * needs the same "qualified role, not per-resource assignment" treatment
 * `sales_supervisor`/`sales_manager` already get.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documentation of the legacy leg; the legacy-admin register (foundation/authorization/legacy-admin-dependency.register.spec.ts) counts this reference
const REVIEWER_ROLES = ['admin', 'sales_supervisor', 'sales_manager', 'finance']; // F5: documentation of the legacy leg; the decision is the rule `sales.customer.read_any`

/**
 * Gap G-5 (planning/excel-mapping/EXCEL_BUSINESS_MAPPING_PACKAGE.md §4) —
 * the real CRM master sheet's own field set, adopted as Daii's Customer
 * shape per CTO instruction. Every field beyond `name` is optional so a
 * plain UI-created customer (which only ever supplies name/phone) keeps
 * working unchanged.
 */
/**
 * Security Assurance Gate — Track S20 (Cleanup), found 2026-09-09 via
 * `jscpd`'s duplicate-code scan: this exact 17-field row shape was
 * written out twice — once here as `importRows`'s own parameter type, and
 * once again at `CustomersController.import`'s call site as an `as
 * Array<{...}>` CAST. A cast suppresses type-checking rather than
 * enforcing it, so the two copies could silently drift apart (a field
 * renamed in one place, not the other) with no compiler error to catch
 * it. Extracted into this one named, exported type so the controller can
 * `import` and reference it directly instead of re-typing/casting.
 */
export interface CustomerImportRow {
  name: string;
  managerName: string;
  address: string;
  governorate: string;
  classification: string;
  phone: string;
  whatsappPhone: string;
  salesRepName: string;
  contactMethod: string;
  responsivenessLevel: string;
  disinterestNotes: string;
  priceSatisfactionLevel: string;
  topBrand: string;
  midBrand: string;
  lowBrand: string;
  shippingMethodPreference: string;
  locationUrl: string;
}

export interface CreateCustomerInput {
  /** Optional (2026-10-20): omitted or blank = the next default serial (`CUST-000001` …); a typed code is used as is if it is valid and free. */
  code?: string | null;
  name: string;
  phone?: string | null;
  managerName?: string | null;
  address?: string | null;
  governorate?: string | null;
  whatsappPhone?: string | null;
  contactMethod?: string | null;
  responsivenessLevel?: string | null;
  disinterestNotes?: string | null;
  priceSatisfactionLevel?: string | null;
  topBrand?: string | null;
  midBrand?: string | null;
  lowBrand?: string | null;
  shippingMethodPreference?: string | null;
  locationUrl?: string | null;
}

/**
 * CRM / Customer Management — Stage 2 build-order item 22.
 * Daii/architecture/DAII_DOMAIN_BOUNDARIES.md §2.
 *
 * The reference pattern for every future Business Domain: a single DB
 * transaction covers the domain write, the outbox event write (ADR-012),
 * and the audit record (ADR-017) together — Scope grants happen in the
 * same transaction too, so a customer is never left assigned-but-not-
 * event-published or vice versa. Every read re-derives Scope server-side
 * (DAII_SECURITY_ARCHITECTURE.md §3) — this service never trusts a
 * caller-supplied "my customers" filter.
 */
@Injectable()
export class CustomersService implements SalesCustomersContract {
  constructor(
    private readonly dataSource: DataSource,
    private readonly numbering: NumberingService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly authorization: AuthorizationService,
    private readonly users: UsersService,
    private readonly limits: LimitService,
  ) {}

  /** The default customer code for the create form — the next `CUST-` serial that is not already taken. A preview only; nothing is issued. */
  async peekNextCode(manager?: EntityManager): Promise<string> {
    return peekEntityCode(this.numbering, manager ?? this.dataSource.manager, CUSTOMER_CODE_KIND);
  }

  /**
   * P5 (Limit Engine) — `sales.max_customers` is the one manifest-declared
   * limit key with an obvious, unambiguous home: one customer record
   * created per call, nothing to batch or approximate. Pre-checked
   * BEFORE the Numbering call (a rejected create must not burn a
   * customer-code sequence slot — same discipline sales-orders already
   * established for `managerPrice` rejections finding real live bugs),
   * then `consume()`d INSIDE the same DB transaction as the insert (the
   * `manager` param) so the two are atomic: if the transaction rolls
   * back for any reason, the limit increment rolls back with it — never
   * a phantom consumed slot for a customer that doesn't exist. Fails
   * open today: `sales.max_customers`'s manifest default is `null`
   * (unlimited), confirmed 2026-09-06 — zero behavior change until an
   * Edition or admin actually sets a cap.
   */
  async createCustomer(input: CreateCustomerInput, createdByUserId: string | null, manager?: EntityManager): Promise<Customer> {
    const gate = await this.limits.check('sales.max_customers', 1, manager);
    if (!gate.allowed) {
      throw new ConflictException(`Customer limit reached (${gate.max}) — cannot create another customer.`);
    }

    // A typed code is checked first (nothing is issued for it); otherwise the next serial is issued, skipping any number a typed code already took.
    const em = manager ?? this.dataSource.manager;
    const explicit = normalizeEntityCode(input.code, CUSTOMER_CODE_KIND, true);
    if (explicit) await assertEntityCodeFree(em, CUSTOMER_CODE_KIND, explicit);
    const code = explicit ?? (await issueEntityCode(this.numbering, em, CUSTOMER_CODE_KIND));

    const customer = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const repo = txManager.getRepository(Customer);
      const saved = await repo
        .save(
        repo.create({
          code,
          name: input.name,
          phone: input.phone ?? null,
          status: 'pending',
          orderWorkflowPolicy: 'standard',
          priceListId: null,
          managerName: input.managerName ?? null,
          address: input.address ?? null,
          governorate: input.governorate ?? null,
          whatsappPhone: input.whatsappPhone ?? null,
          contactMethod: input.contactMethod ?? null,
          responsivenessLevel: input.responsivenessLevel ?? null,
          disinterestNotes: input.disinterestNotes ?? null,
          priceSatisfactionLevel: input.priceSatisfactionLevel ?? null,
          topBrand: input.topBrand ?? null,
          midBrand: input.midBrand ?? null,
          lowBrand: input.lowBrand ?? null,
          shippingMethodPreference: input.shippingMethodPreference ?? null,
          locationUrl: input.locationUrl ?? null,
        }),
        )
        .catch((err) => rethrowDuplicateCode(err, CUSTOMER_CODE_KIND, code));

      const consumed = await this.limits.consume('sales.max_customers', 1, txManager);
      if (!consumed.allowed) {
        // Lost a race against a concurrent create between the pre-check
        // above and here — throwing inside the transaction rolls back
        // the customer insert too, so no orphaned row and no phantom
        // quota consumption either.
        throw new ConflictException(`Customer limit reached (${consumed.max}) — cannot create another customer.`);
      }

      await this.events.publish(txManager, 'crm.customer.created', {
        customerId: saved.id,
        code: saved.code,
        name: saved.name,
      });

      return saved;
    });

    // Audit intentionally happens after commit — it is a record OF the
    // committed fact, not a condition of the write succeeding, same as
    // Scope in assignSalesRep() below (a failure here is an operational
    // alerting concern, not grounds to roll back a valid customer record).
    await this.audit.record(
      {
        actorUserId: createdByUserId,
        organizationId: null,
        action: 'crm.customer.created',
        resource: 'customer',
        resourceId: customer.id,
        result: 'success',
        correlationId: null,
        after: { code: customer.code, name: customer.name, status: customer.status },
      },
      manager,
    );

    return customer;
  }

  async assignSalesRep(
    customerId: string,
    salesRepUserId: string,
    assignmentType: 'primary' | 'secondary',
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<CustomerAssignment> {
    const assignment = await (manager ?? this.dataSource).transaction(async (txManager) => {
      const assignmentRepo = txManager.getRepository(CustomerAssignment);

      // End any existing active assignment of the same type — history preserved, never overwritten.
      await txManager.query(
        'UPDATE customer_assignments SET status = $1, "endDate" = now() WHERE "customerId" = $2 AND "assignmentType" = $3 AND status = $4',
        ['ended', customerId, assignmentType, 'active'],
      );

      const created = await assignmentRepo.save(
        assignmentRepo.create({ customerId, salesRepUserId, assignmentType, status: 'active' }),
      );

      await this.events.publish(txManager, 'crm.customer.assigned', {
        customerId,
        salesRepUserId,
        assignmentType,
      });

      return created;
    });

    // Scope grant happens after the assignment commits — a Scope Engine
    // failure must not silently roll back a valid assignment record; if
    // this fails, it is a real operational issue (retried/alerted at the
    // infrastructure layer), not swallowed here.
    await this.scope.assign(salesRepUserId, 'customer', customerId, manager);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'crm.customer.assigned',
        resource: 'customer',
        resourceId: customerId,
        result: 'success',
        correlationId: null,
        after: { salesRepUserId, assignmentType },
      },
      manager,
    );

    return assignment;
  }

  /**
   * Excel import — Gap G-5, CTO instruction: the import/export format IS
   * the real CRM master sheet's own columns (`احمد/شيت تحليل العملاء
   * الرئيسي الجديد.xlsx`, sheet `بيانات العملاء`), not an invented
   * shape. Enters through the same `createCustomer`/`assignSalesRep`
   * calls the UI uses, per row.
   *
   * A Sales Representative is matched by NAME (`اسم المندوب`) because
   * that is the only identifier the real source sheet carries — no
   * email column exists in it. `UsersService.findByFullName` returns
   * null for both "not found" and "ambiguous" (two reps share the
   * name); either way the ROW is rejected (no customer created) rather
   * than silently importing an unassigned customer — a rep name typo in
   * a bulk import should surface as a visible per-row error the
   * operator fixes, not a customer that quietly has no owner. Leave the
   * column blank to import a customer with no rep assignment on
   * purpose.
   */
  async importRows(
    rows: CustomerImportRow[],
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<{ succeeded: Customer[]; rejected: Array<{ row: number; errors: string[] }> }> {
    const succeeded: Customer[] = [];
    const rejected: Array<{ row: number; errors: string[] }> = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;
      const raw = rows[i];
      const errors: string[] = [];
      const name = raw.name.trim();
      const salesRepName = raw.salesRepName.trim();

      if (!name) errors.push('Customer Name is required.');

      let salesRepUserId: string | null = null;
      if (salesRepName) {
        const rep = await this.users.findByFullName(salesRepName);
        if (!rep) {
          errors.push(`Sales Representative "${salesRepName}" was not found (or the name matches more than one user) — customer will not be created until this is fixed or the column left blank.`);
        } else {
          salesRepUserId = rep.id;
        }
      }

      if (errors.length > 0) {
        rejected.push({ row: rowNumber, errors });
        continue;
      }

      try {
        const customer = await this.createCustomer(
          {
            name,
            phone: raw.phone.trim() || null,
            managerName: raw.managerName.trim() || null,
            address: raw.address.trim() || null,
            governorate: raw.governorate.trim() || null,
            whatsappPhone: raw.whatsappPhone.trim() || null,
            contactMethod: raw.contactMethod.trim() || null,
            responsivenessLevel: raw.responsivenessLevel.trim() || null,
            disinterestNotes: raw.disinterestNotes.trim() || null,
            priceSatisfactionLevel: raw.priceSatisfactionLevel.trim() || null,
            topBrand: raw.topBrand.trim() || null,
            midBrand: raw.midBrand.trim() || null,
            lowBrand: raw.lowBrand.trim() || null,
            shippingMethodPreference: raw.shippingMethodPreference.trim() || null,
            locationUrl: raw.locationUrl.trim() || null,
          },
          actorUserId,
          manager,
        );
        if (raw.classification.trim()) {
          await this.setClassification(customer.id, raw.classification.trim(), actorUserId, manager);
          customer.classification = raw.classification.trim();
        }
        if (salesRepUserId) {
          await this.assignSalesRep(customer.id, salesRepUserId, 'primary', actorUserId, manager);
        }
        succeeded.push(customer);
      } catch (err) {
        rejected.push({ row: rowNumber, errors: [err instanceof Error ? err.message : 'Unknown error creating customer.'] });
      }
    }

    return { succeeded, rejected };
  }

  async setStatus(customerId: string, newStatus: CustomerStatus, actorUserId: string | null, manager?: EntityManager): Promise<Customer> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const customer = await repo.findOneOrFail({ where: { id: customerId } });
    if (!canTransitionCustomerStatus(customer.status, newStatus)) {
      throw new ConflictException(`Cannot transition customer from "${customer.status}" to "${newStatus}".`);
    }
    const before = { status: customer.status };
    customer.status = newStatus;
    const saved = await repo.save(customer);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'crm.customer.status_changed',
        resource: 'customer',
        resourceId: customerId,
        result: 'success',
        correlationId: null,
        before,
        after: { status: newStatus },
      },
      manager,
    );

    return saved;
  }

  /**
   * Changes which Sales Order workflow a customer's FUTURE orders run
   * under (Gap G-1 — CTO handover directive §6). Never retroactive:
   * `SalesOrder.workflowPolicy` is snapshotted at order-creation time, so
   * orders already in flight keep running the chain they started under.
   * Route-gated to admin/sales_manager (see `customers.controller.ts`) —
   * this is a business-policy decision, not a per-rep action.
   */
  async setOrderWorkflowPolicy(
    customerId: string,
    policy: OrderWorkflowPolicy,
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<Customer> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const customer = await repo.findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);

    const before = { orderWorkflowPolicy: customer.orderWorkflowPolicy };
    customer.orderWorkflowPolicy = policy;
    const saved = await repo.save(customer);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'crm.customer.workflow_policy_changed',
        resource: 'customer',
        resourceId: customerId,
        result: 'success',
        correlationId: null,
        before,
        after: { orderWorkflowPolicy: policy },
      },
      manager,
    );

    return saved;
  }

  /**
   * Cross-domain read contract for Sales Orders (DAII_DOMAIN_BOUNDARIES.md
   * Cross-Domain Rule) — same pattern as Commerce's
   * `ProductsService.getProductSnapshot`. Sales Orders never queries
   * CRM's `customers` table directly; it reads this published snapshot to
   * decide which Process Definition governs a new order. Unscoped by
   * design: the caller (`SalesOrdersService.createOrder`) has already
   * enforced Scope on `customerId` via `ScopeService.assertAccess` before
   * calling this.
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — Customer is Company-owned, called from Company-scoped flows (e.g. `SalesOrdersService.createOrder`). */
  async getWorkflowPolicySnapshot(customerId: string, manager?: EntityManager): Promise<OrderWorkflowPolicy> {
    const customer = await (manager ?? this.dataSource).getRepository(Customer).findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);
    return isValidOrderWorkflowPolicy(customer.orderWorkflowPolicy) ? customer.orderWorkflowPolicy : 'standard';
  }

  /**
   * Gap G-3 — assigns (or clears, with `priceListId: null`) which Commerce
   * Price List a customer's FUTURE orders resolve prices against. Never
   * retroactive: `SalesOrderLine.priceListId` is snapshotted at
   * order-creation time, same discipline as `setOrderWorkflowPolicy`
   * above. Deliberately does NOT validate `priceListId` against Commerce's
   * `price_lists` table here — CRM never queries another domain's table
   * directly (DAII_DOMAIN_BOUNDARIES.md Cross-Domain Rule); an unknown or
   * inactive id simply resolves to no override at order time
   * (`PriceListsService.getOverridePrice` returns null for either case),
   * never a hard failure on the assignment call itself.
   */
  async setPriceList(customerId: string, priceListId: string | null, actorUserId: string | null, manager?: EntityManager): Promise<Customer> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const customer = await repo.findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);

    const before = { priceListId: customer.priceListId };
    customer.priceListId = priceListId;
    const saved = await repo.save(customer);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'crm.customer.price_list_changed',
        resource: 'customer',
        resourceId: customerId,
        result: 'success',
        correlationId: null,
        before,
        after: { priceListId },
      },
      manager,
    );

    return saved;
  }

  /**
   * Sets a customer's free-text organization/classification note
   * (`Customer.classification` — column existed already but had no
   * write path anywhere: no controller route, no service method).
   * Same shape as `setPriceList`/`setOrderWorkflowPolicy`; completes the
   * existing data model rather than adding a new one.
   */
  async setClassification(customerId: string, classification: string | null, actorUserId: string | null, manager?: EntityManager): Promise<Customer> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const customer = await repo.findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);

    const before = { classification: customer.classification };
    customer.classification = classification;
    const saved = await repo.save(customer);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'crm.customer.classification_changed',
        resource: 'customer',
        resourceId: customerId,
        result: 'success',
        correlationId: null,
        before,
        after: { classification },
      },
      manager,
    );

    return saved;
  }

  /**
   * Customer Financial Account / AR (CTO directive §10 — Credit Control).
   * Same shape as `setClassification`/`setPriceList` — a commercial
   * finance-policy decision, admin-gated at the controller. `undefined`
   * fields are left untouched (a partial update, same "explicit
   * null-ish clear vs. not-provided" discipline as `SetPriceListDto`).
   */
  async setFinancialSettings(
    customerId: string,
    updates: { creditLimit?: string | null; paymentTermsDays?: number | null; accountType?: 'cash' | 'credit'; financialStatus?: 'active' | 'on_hold' | 'suspended' },
    actorUserId: string | null,
    manager?: EntityManager,
  ): Promise<Customer> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const customer = await repo.findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);

    const before = {
      creditLimit: customer.creditLimit,
      paymentTermsDays: customer.paymentTermsDays,
      accountType: customer.accountType,
      financialStatus: customer.financialStatus,
    };
    if (updates.creditLimit !== undefined) customer.creditLimit = updates.creditLimit;
    if (updates.paymentTermsDays !== undefined) customer.paymentTermsDays = updates.paymentTermsDays;
    if (updates.accountType !== undefined) customer.accountType = updates.accountType;
    if (updates.financialStatus !== undefined) customer.financialStatus = updates.financialStatus;
    const saved = await repo.save(customer);

    await this.audit.record(
      {
        actorUserId,
        organizationId: null,
        action: 'crm.customer.financial_settings_changed',
        resource: 'customer',
        resourceId: customerId,
        result: 'success',
        correlationId: null,
        before,
        after: updates,
      },
      manager,
    );

    return saved;
  }

  /** Cross-domain read contract for Sales Orders — same pattern as `getWorkflowPolicySnapshot`. */
  async getPriceListId(customerId: string, manager?: EntityManager): Promise<string | null> {
    const customer = await (manager ?? this.dataSource).getRepository(Customer).findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);
    return customer.priceListId;
  }

  /**
   * Cross-domain read contract for External Integrations (QR order
   * intake, CTO handover directive) — resolves a customer by phone
   * number so a repeat QR customer's order attaches to their existing
   * Daii Customer record rather than creating a duplicate every time.
   * Unscoped by design, same discipline as `getWorkflowPolicySnapshot` —
   * the caller is a system-level integration flow, not a Scope-bound
   * user request.
   */
  async findByPhone(phone: string): Promise<Customer | null> {
    return this.dataSource.getRepository(Customer).findOne({ where: { phone } });
  }

  /** Same unscoped system-lookup precedent as `findByPhone` — Returns Engine Phase B's "search by Customer Code" facet (shipping/vehicle custody return search). Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — called cross-domain from `ShipmentService.searchCustodyShipments`. */
  async findByCode(code: string, manager?: EntityManager): Promise<Customer | null> {
    return (manager ?? this.dataSource).getRepository(Customer).findOne({ where: { code } });
  }

  /**
   * Cross-domain read contract for Sales Orders' detail screen (same
   * pattern as `ProductsService.getProductSnapshot`) — a customer's
   * name/phone/code for display, unscoped: the caller (`getOrder`) has
   * already authorized access to the ORDER, which is the real boundary
   * here, not a second independent Scope check on the customer.
   */
  async getCustomerSnapshot(
    customerId: string,
    manager?: EntityManager,
  ): Promise<{ id: string; code: string; name: string; phone: string | null; address: string | null; governorate: string | null } | null> {
    const customer = await (manager ?? this.dataSource).getRepository(Customer).findOne({ where: { id: customerId } });
    if (!customer) return null;
    return {
      id: customer.id,
      code: customer.code,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      governorate: customer.governorate,
    };
  }

  /**
   * P4 Tranche-2 (ERP Foundation) — cross-domain read contract for
   * Customer-Finance's `getCreditSummary` (Customer Account Dashboard,
   * CTO directive §11), which previously queried the `Customer` entity
   * directly via a raw repository call (`dataSource.getRepository(Customer)`)
   * from OUTSIDE this domain — the deepest form of the `finance ↔ sales`
   * coupling (F-MOD-2), a compile-time entity import, not just a service
   * call. Same unscoped-read rationale as `getCustomerSnapshot` just above:
   * the caller has already authorized access to the LEDGER/CUSTOMER
   * ACCOUNT, which is the real boundary, not a second Scope check here.
   */
  /** Area 21 Operational Company Scoping Retrofit (2026-09-27): `manager?` added — Customer is Company-owned, called from `CustomerLedgerService.getCreditSummary` via the Company-scoped `customer-ledger.controller.ts`. */
  async getCreditLimit(customerId: string, manager?: EntityManager): Promise<string | null> {
    const customer = await (manager ?? this.dataSource).getRepository(Customer).findOne({ where: { id: customerId } });
    return customer?.creditLimit ?? null;
  }

  /**
   * Backs the customer Excel export's `اسم المندوب` column (Gap G-5) —
   * the currently assigned primary rep's name isn't a `Customer` column
   * (it's `CustomerAssignment`, kept history-tracked per blueprint §10),
   * so export needs this one join, done once for the whole batch rather
   * than per-row.
   */
  async getPrimaryRepNamesByCustomerId(customerIds: string[], manager?: EntityManager): Promise<Map<string, string>> {
    if (customerIds.length === 0) return new Map();
    const rows: Array<{ customerId: string; fullName: string }> = await (manager ?? this.dataSource).query(
      `SELECT ca."customerId" as "customerId", u."fullName" as "fullName"
       FROM customer_assignments ca
       JOIN users u ON u.id = ca."salesRepUserId"
       WHERE ca."assignmentType" = 'primary' AND ca.status = 'active' AND ca."customerId" = ANY($1)`,
      [customerIds],
    );
    return new Map(rows.map((r) => [r.customerId, r.fullName]));
  }

  /** Scope-checked detail read — 404s (never 403s) for a customer outside the caller's scope. Reviewer roles bypass Scope (see REVIEWER_ROLES doc comment). */
  async getCustomer(customerId: string, requestingUserId: string, manager?: EntityManager): Promise<Customer> {
    const access = await this.authorization.workflowAccess(requestingUserId, manager);
    if (!access.allows('sales.customer.read_any')) {
      await this.scope.assertAccess(requestingUserId, 'customer', customerId, manager);
    }
    return (manager ?? this.dataSource).getRepository(Customer).findOneOrFail({ where: { id: customerId } });
  }

  /**
   * Scope-filtered list — an indexed `WHERE id IN (...)` query, never a
   * fetch-everything-then-filter-in-application-code pattern
   * (DAII_SECURITY_ARCHITECTURE.md §3's "efficient row-level filtering"
   * requirement, applied here as the reference implementation). Reviewer
   * roles see the full list (see REVIEWER_ROLES doc comment).
   */
  async listCustomers(requestingUserId: string, manager?: EntityManager): Promise<Customer[]> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const access = await this.authorization.workflowAccess(requestingUserId, manager);
    if (access.allows('sales.customer.read_any')) return repo.find();
    const allowedIds = await this.scope.getAssignedResourceIds(requestingUserId, 'customer', manager);
    if (allowedIds === 'ALL') return repo.find();
    if (allowedIds.length === 0) return [];
    return repo.find({ where: { id: In(allowedIds) } });
  }

  /**
   * CTO directive ("PRIORITY 1 — CUSTOMER VISIBILITY BY SALES
   * REPRESENTATIVE"): when a manager/admin picks a specific rep in the
   * Sales Order rep-selector, the customer list must narrow to ONLY that
   * rep's assigned customers — never the full list `listCustomers` gives
   * a reviewer by default. Reuses the exact same Scope grants
   * `assignSalesRep` already writes (`scope.assign(salesRepUserId,
   * 'customer', customerId)`) — no parallel assignment lookup, so this
   * can never drift from what `listCustomers`'s own rep-branch already
   * enforces for a rep viewing their OWN list.
   *
   * Server-side is the real boundary, not just this narrowing: a plain
   * rep may only ever pass their OWN id (or omit the param, same as
   * `listCustomers`) — requesting anyone else's is rejected outright, so
   * a direct API call can't bypass the UI's own rep-selector gating
   * (directive: "must be technically unable... through a direct API
   * call").
   */
  async listCustomersForRep(requestingUserId: string, targetSalesRepUserId?: string, manager?: EntityManager): Promise<Customer[]> {
    if (!targetSalesRepUserId) return this.listCustomers(requestingUserId, manager);

    const access = await this.authorization.workflowAccess(requestingUserId, manager);
    const isReviewer = access.allows('sales.customer.read_any');
    if (!isReviewer && targetSalesRepUserId !== requestingUserId) {
      throw new ForbiddenException("Only a sales manager/supervisor/admin may view another Sales Representative's customers.");
    }

    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const allowedIds = await this.scope.getAssignedResourceIds(targetSalesRepUserId, 'customer', manager);
    if (allowedIds === 'ALL') return repo.find();
    if (allowedIds.length === 0) return [];
    return repo.find({ where: { id: In(allowedIds) } });
  }

  /**
   * Pagination audit fix (MASTER_PROJECT_STATUS.md §6 — `listCustomers`
   * was one of 5 confirmed-unbounded `repo.find()` list endpoints).
   * `listCustomers`/`listCustomersForRep` are deliberately left
   * unpaginated — every internal caller (Excel export, invoices/
   * payments/customer-ledger/returns name-lookup maps, ReportsService)
   * needs the FULL set, never one page of it, so changing their shape
   * would either break those call sites or silently truncate a report.
   * This is the new, real, take/skip-bounded sibling that backs the
   * operational Customers screen's table specifically — same
   * Scope-vs-Role split (and the same rep-narrowing permission check as
   * `listCustomersForRep`) as both of those, just paginated.
   */
  async listCustomersPage(
    requestingUserId: string,
    options: { salesRepUserId?: string; search?: string; page: number; pageSize: number },
    manager?: EntityManager,
  ): Promise<{ rows: Customer[]; total: number }> {
    const repo = (manager ?? this.dataSource).getRepository(Customer);
    const access = await this.authorization.workflowAccess(requestingUserId, manager);
    const isReviewer = access.allows('sales.customer.read_any');

    let allowedIds: 'ALL' | string[];
    if (options.salesRepUserId) {
      if (!isReviewer && options.salesRepUserId !== requestingUserId) {
        throw new ForbiddenException("Only a sales manager/supervisor/admin may view another Sales Representative's customers.");
      }
      allowedIds = await this.scope.getAssignedResourceIds(options.salesRepUserId, 'customer', manager);
    } else if (isReviewer) {
      allowedIds = 'ALL';
    } else {
      allowedIds = await this.scope.getAssignedResourceIds(requestingUserId, 'customer', manager);
    }

    if (allowedIds !== 'ALL' && allowedIds.length === 0) {
      return { rows: [], total: 0 };
    }

    // Smart Lookup UX initiative — Customer is unbounded (can reach
    // thousands), so its lookup needs real server-side search rather than
    // a full client-side fetch. `search` matches code/name/phone
    // (case-insensitive, partial), AND-ed with the existing Scope filter
    // via a QueryBuilder (a plain object `where` can't express an OR-group
    // ANDed with the id-in-list restriction). A single parenthesised OR
    // string (rather than `Brackets`) keeps this trivially mockable in
    // tests — no query-builder callback to simulate.
    const qb = repo.createQueryBuilder('customer').orderBy('customer.createdAt', 'DESC').take(options.pageSize).skip((options.page - 1) * options.pageSize);
    if (allowedIds !== 'ALL') qb.andWhere('customer.id IN (:...allowedIds)', { allowedIds });
    const search = options.search?.trim();
    if (search) {
      qb.andWhere('(customer.name ILIKE :search OR customer.code ILIKE :search OR customer.phone ILIKE :search)', { search: `%${search}%` });
    }
    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }
}
