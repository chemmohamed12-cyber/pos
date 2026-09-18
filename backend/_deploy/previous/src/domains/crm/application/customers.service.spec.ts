import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { Customer } from '../infrastructure/customer.entity';
import { CustomerAssignment } from '../infrastructure/customer-assignment.entity';
import { NumberingService } from '../../../foundation/numbering/numbering.service';
import { ScopeService } from '../../../foundation/scope/scope.service';
import { AuditService } from '../../../foundation/audit/audit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';
import { AuthorizationService } from '../../../foundation/authorization/authorization.service';
import { UsersService } from '../../../foundation/identity/users.service';

/**
 * Reference-pattern test for every future domain: scope enforcement,
 * event publication, audit recording, and the assignment-history
 * invariant (a reassignment ends the old row, never overwrites it).
 */
describe('CustomersService', () => {
  let service: CustomersService;
  const customers = new Map<string, Customer>();
  const assignments: CustomerAssignment[] = [];
  let idSeq = 0;

  function customerRepo() {
    return {
      create: jest.fn((data: Partial<Customer>) => ({ id: `cust-${++idSeq}`, ...data }) as Customer),
      save: jest.fn(async (c: Customer) => {
        customers.set(c.id, c);
        return c;
      }),
      findOneOrFail: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = customers.get(where.id);
        if (!found) throw new Error('not found');
        return found;
      }),
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => customers.get(where.id) ?? null),
      find: jest.fn(async (opts?: { where?: { id: { value: string[] } } }) => {
        const all = [...customers.values()];
        if (!opts?.where) return all;
        return all.filter((c) => opts.where!.id.value.includes(c.id));
      }),
      findAndCount: jest.fn(async (opts?: { where?: { id?: { value: string[] } }; take?: number; skip?: number }) => {
        const all = [...customers.values()];
        const filtered = opts?.where?.id ? all.filter((c) => opts.where!.id!.value.includes(c.id)) : all;
        const skip = opts?.skip ?? 0;
        const take = opts?.take ?? filtered.length;
        return [filtered.slice(skip, skip + take), filtered.length] as [Customer[], number];
      }),
    };
  }

  function assignmentRepo() {
    return {
      create: jest.fn((data: Partial<CustomerAssignment>) => ({ id: `asg-${assignments.length + 1}`, startDate: new Date(), endDate: null, ...data }) as CustomerAssignment),
      save: jest.fn(async (a: CustomerAssignment) => {
        assignments.push(a);
        return a;
      }),
    };
  }

  const publishedEvents: Array<{ topic: string; payload: unknown }> = [];
  const auditRecords: unknown[] = [];

  const getRepositoryMock = jest.fn((entity: unknown) => (entity === Customer ? customerRepo() : assignmentRepo()));

  const dataSourceMock = {
    getRepository: getRepositoryMock,
    query: jest.fn(async () => []),
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => {
      const manager = {
        getRepository: getRepositoryMock,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('UPDATE customer_assignments')) {
            const [, customerId, assignmentType] = params as [string, string, string];
            assignments
              .filter((a) => a.customerId === customerId && a.assignmentType === assignmentType && a.status === 'active')
              .forEach((a) => {
                a.status = 'ended';
                a.endDate = new Date();
              });
          }
          return [];
        }),
      };
      return fn(manager);
    }),
  };

  const numberingMock = { getNextNumber: jest.fn(async () => 'CUST-000001') };
  const scopeMock = {
    assign: jest.fn(async () => undefined),
    assertAccess: jest.fn(async (userId: string, _type: string, _resourceId: string) => {
      if (userId === 'unscoped-user') throw new NotFoundException();
    }),
    getAssignedResourceIds: jest.fn(async (userId: string) =>
      userId === 'admin' ? 'ALL' : userId === 'rep-2' ? ['cust-2'] : ['cust-1'],
    ),
  };
  const auditMock = { record: jest.fn(async (r: unknown) => { auditRecords.push(r); }) };
  const authorizationMock = {
    getRoleKeysForUser: jest.fn(async (userId: string) =>
      userId === 'admin' ? ['admin'] : userId === 'manager-1' ? ['sales_manager'] : userId === 'finance-1' ? ['finance'] : [],
    ),
  };
  const usersMock = {
    findByEmail: jest.fn(async (email: string) => (email === 'rep@daii.example' ? { id: 'rep-1', email } : null)),
    findByFullName: jest.fn(async (fullName: string) => (fullName === 'ا حسين' ? { id: 'rep-1', fullName } : null)),
  };
  const eventsMock = {
    publish: jest.fn(async (_manager: unknown, topic: string, payload: unknown) => {
      publishedEvents.push({ topic, payload });
    }),
  };

  beforeEach(async () => {
    customers.clear();
    assignments.length = 0;
    publishedEvents.length = 0;
    auditRecords.length = 0;
    idSeq = 0;
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: NumberingService, useValue: numberingMock },
        { provide: ScopeService, useValue: scopeMock },
        { provide: AuditService, useValue: auditMock },
        { provide: EventBusService, useValue: eventsMock },
        { provide: AuthorizationService, useValue: authorizationMock },
        { provide: UsersService, useValue: usersMock },
      ],
    }).compile();
    service = moduleRef.get(CustomersService);
  });

  it('creates a customer with a Numbering-issued code, publishes an event, and records an audit entry', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading', phone: '+201000000000' }, 'creator-1');
    expect(customer.code).toBe('CUST-000001');
    expect(customer.status).toBe('pending');
    expect(publishedEvents).toEqual([
      { topic: 'crm.customer.created', payload: { customerId: customer.id, code: 'CUST-000001', name: 'Acme Trading' } },
    ]);
    expect(auditRecords).toHaveLength(1);
  });

  it('getCustomerSnapshot includes address/governorate (CTO directive — Fulfillment "New Order" screen needs the shipping address up front)', async () => {
    const customer = await service.createCustomer(
      { name: 'Acme Trading', phone: '+201000000000', address: '12 Nile St.', governorate: 'Cairo' },
      null,
    );
    const snapshot = await service.getCustomerSnapshot(customer.id);
    expect(snapshot).toEqual({
      id: customer.id,
      code: customer.code,
      name: 'Acme Trading',
      phone: '+201000000000',
      address: '12 Nile St.',
      governorate: 'Cairo',
    });
  });

  it('ends the previous active assignment of the same type rather than overwriting it (history preserved)', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    await service.assignSalesRep(customer.id, 'rep-1', 'primary', 'actor-1');
    await service.assignSalesRep(customer.id, 'rep-2', 'primary', 'actor-1');

    expect(assignments).toHaveLength(2);
    expect(assignments[0].salesRepUserId).toBe('rep-1');
    expect(assignments[0].status).toBe('ended');
    expect(assignments[0].endDate).not.toBeNull();
    expect(assignments[1].salesRepUserId).toBe('rep-2');
    expect(assignments[1].status).toBe('active');
  });

  it('grants Scope to the newly assigned sales rep', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    await service.assignSalesRep(customer.id, 'rep-1', 'primary', 'actor-1');
    expect(scopeMock.assign).toHaveBeenCalledWith('rep-1', 'customer', customer.id);
  });

  it('denies getCustomer for a caller outside the customer\'s scope (404, via ScopeService)', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    await expect(service.getCustomer(customer.id, 'unscoped-user')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getCustomer succeeds for a finance-role caller with no Scope assignment to this customer (REAL BUG FOUND LIVE, Returns/Custody-Settlement E2E — finance was missing from REVIEWER_ROLES, same class of gap as the already-fixed SalesOrdersService.getOrder task_cf32e266; finance is @RequireRole-gated onto invoice/AR/Customer-Statement routes across the codebase but was never individually Scope-assigned to customers, so every one of those routes 404\'d)', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    await expect(service.getCustomer(customer.id, 'finance-1')).resolves.toEqual(customer);
    expect(scopeMock.assertAccess).not.toHaveBeenCalled();
  });

  it('lists only scoped customers for a non-admin caller', async () => {
    await service.createCustomer({ name: 'Customer One' }, null); // becomes cust-1 per idSeq
    const result = await service.listCustomers('rep-1');
    expect(result.map((c) => c.id)).toEqual(['cust-1']);
  });

  it('lists all customers for an unrestricted-scope caller', async () => {
    await service.createCustomer({ name: 'Customer One' }, null);
    const result = await service.listCustomers('admin');
    expect(result).toHaveLength(1);
  });

  it('lists all customers for a finance-role caller too (same reviewer treatment as admin/sales_manager)', async () => {
    await service.createCustomer({ name: 'Customer One' }, null);
    const result = await service.listCustomers('finance-1');
    expect(result).toHaveLength(1);
  });

  describe('listCustomersForRep (CTO directive — customer visibility by Sales Representative)', () => {
    it('narrows to exactly the SELECTED rep\'s customers, not the caller\'s own scope, when a manager picks a rep', async () => {
      await service.createCustomer({ name: 'Customer One' }, null); // cust-1, scoped to rep-1
      await service.createCustomer({ name: 'Customer Two' }, null); // cust-2, scoped to rep-2

      const forRep1 = await service.listCustomersForRep('manager-1', 'rep-1');
      expect(forRep1.map((c) => c.id)).toEqual(['cust-1']);

      const forRep2 = await service.listCustomersForRep('manager-1', 'rep-2');
      expect(forRep2.map((c) => c.id)).toEqual(['cust-2']);
    });

    it('lets a plain rep request their OWN id explicitly, same result as listCustomers', async () => {
      await service.createCustomer({ name: 'Customer One' }, null);
      const result = await service.listCustomersForRep('rep-1', 'rep-1');
      expect(result.map((c) => c.id)).toEqual(['cust-1']);
    });

    it('rejects a plain rep requesting a DIFFERENT rep\'s customers — the direct-API-call bypass the directive explicitly calls out', async () => {
      await expect(service.listCustomersForRep('rep-1', 'rep-2')).rejects.toThrow(
        "Only a sales manager/supervisor/admin may view another Sales Representative's customers.",
      );
    });

    it('with no target rep supplied, behaves exactly like listCustomers (own scope for a rep, everyone for a reviewer)', async () => {
      await service.createCustomer({ name: 'Customer One' }, null);
      const asRep = await service.listCustomersForRep('rep-1');
      expect(asRep.map((c) => c.id)).toEqual(['cust-1']);
      const asAdmin = await service.listCustomersForRep('admin');
      expect(asAdmin).toHaveLength(1);
    });
  });

  describe('listCustomersPage (pagination audit fix, MASTER_PROJECT_STATUS.md §6 — offset/limit math and total-under-filters, same Scope-vs-Role split as listCustomers/listCustomersForRep)', () => {
    it('paginates a reviewer\'s full visible set correctly: disjoint pages, and total reflects every row, not just the page', async () => {
      for (let i = 0; i < 5; i++) await service.createCustomer({ name: `Customer ${i}` }, null); // all scoped to rep-1 per scopeMock's default branch

      const page1 = await service.listCustomersPage('admin', { page: 1, pageSize: 2 });
      const page2 = await service.listCustomersPage('admin', { page: 2, pageSize: 2 });
      const page3 = await service.listCustomersPage('admin', { page: 3, pageSize: 2 });

      expect(page1.total).toBe(5);
      expect(page2.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      expect(page2.rows).toHaveLength(2);
      expect(page3.rows).toHaveLength(1);
      const page1Ids = page1.rows.map((c) => c.id);
      const page2Ids = page2.rows.map((c) => c.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
    });

    it('a non-reviewer only ever sees, and is only ever counted against, their own scoped customers', async () => {
      await service.createCustomer({ name: 'Customer One' }, null); // cust-1, scoped to rep-1
      const result = await service.listCustomersPage('rep-1', { page: 1, pageSize: 50 });
      expect(result.total).toBe(1);
      expect(result.rows.map((c) => c.id)).toEqual(['cust-1']);
    });

    it('rejects a plain rep requesting a DIFFERENT rep\'s customers via salesRepUserId, same as listCustomersForRep', async () => {
      await expect(service.listCustomersPage('rep-1', { salesRepUserId: 'rep-2', page: 1, pageSize: 50 })).rejects.toThrow(
        "Only a sales manager/supervisor/admin may view another Sales Representative's customers.",
      );
    });

    it('narrows to the target rep\'s customers when a manager passes salesRepUserId, same as listCustomersForRep', async () => {
      await service.createCustomer({ name: 'Customer One' }, null); // cust-1, scoped to rep-1
      await service.createCustomer({ name: 'Customer Two' }, null); // cust-2, scoped to rep-2
      const result = await service.listCustomersPage('manager-1', { salesRepUserId: 'rep-2', page: 1, pageSize: 50 });
      expect(result.rows.map((c) => c.id)).toEqual(['cust-2']);
      expect(result.total).toBe(1);
    });
  });

  it('rejects an invalid status transition', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    await expect(service.setStatus(customer.id, 'suspended', 'actor-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a valid status transition and audits it', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    const updated = await service.setStatus(customer.id, 'active', 'actor-1');
    expect(updated.status).toBe('active');
    expect(auditRecords).toHaveLength(2); // create + status_changed
  });

  it('defaults a new customer to the standard workflow policy (Gap G-1)', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    expect(customer.orderWorkflowPolicy).toBe('standard');
    expect(await service.getWorkflowPolicySnapshot(customer.id)).toBe('standard');
  });

  it('switches a customer to open_account and audits the change, without touching status', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    const updated = await service.setOrderWorkflowPolicy(customer.id, 'open_account', 'manager-1');
    expect(updated.orderWorkflowPolicy).toBe('open_account');
    expect(await service.getWorkflowPolicySnapshot(customer.id)).toBe('open_account');
    expect(auditRecords).toHaveLength(2); // create + workflow_policy_changed
  });

  it('getWorkflowPolicySnapshot 404s for an unknown customer', async () => {
    await expect(service.getWorkflowPolicySnapshot('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('defaults a new customer to no Price List assignment (Gap G-3)', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    expect(customer.priceListId).toBeNull();
    expect(await service.getPriceListId(customer.id)).toBeNull();
  });

  it('assigns and then clears a customer\'s Price List, auditing both', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    const assigned = await service.setPriceList(customer.id, 'pl-1', 'manager-1');
    expect(assigned.priceListId).toBe('pl-1');
    expect(await service.getPriceListId(customer.id)).toBe('pl-1');

    const cleared = await service.setPriceList(customer.id, null, 'manager-1');
    expect(cleared.priceListId).toBeNull();
    expect(auditRecords).toHaveLength(3); // create + assign + clear
  });

  it('transitions a customer through pending -> active -> suspended -> active, auditing each change', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    expect(customer.status).toBe('pending');

    const active = await service.setStatus(customer.id, 'active', 'admin-1');
    expect(active.status).toBe('active');
    const suspended = await service.setStatus(customer.id, 'suspended', 'admin-1');
    expect(suspended.status).toBe('suspended');
    const reactivated = await service.setStatus(customer.id, 'active', 'admin-1');
    expect(reactivated.status).toBe('active');
    expect(auditRecords).toHaveLength(4); // create + 3 status changes
  });

  it('rejects an illegal customer status transition (e.g. suspended straight to pending)', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    await service.setStatus(customer.id, 'active', 'admin-1');
    await service.setStatus(customer.id, 'suspended', 'admin-1');
    await expect(service.setStatus(customer.id, 'pending', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('sets and clears a customer\'s classification note — a real gap: the column existed with no write path anywhere before this', async () => {
    const customer = await service.createCustomer({ name: 'Acme Trading' }, null);
    expect(customer.classification).toBeFalsy(); // no create-time input for this field — unset by default

    const withClassification = await service.setClassification(customer.id, 'VIP Wholesale', 'manager-1');
    expect(withClassification.classification).toBe('VIP Wholesale');

    const cleared = await service.setClassification(customer.id, null, 'manager-1');
    expect(cleared.classification).toBeNull();
    expect(auditRecords).toHaveLength(3); // create + set + clear
  });

  it('persists the real CRM master sheet\'s own fields on create (Gap G-5)', async () => {
    const customer = await service.createCustomer(
      {
        name: 'Aylin Restaurant & cafe',
        managerName: 'استاذ مصطفي',
        address: 'مول طنطا',
        governorate: 'الغربيه',
        whatsappPhone: '01067100334',
        contactMethod: 'phone',
        responsivenessLevel: 'high',
        priceSatisfactionLevel: 'satisfied',
        topBrand: 'Eco',
        midBrand: 'Lite',
        lowBrand: 'Pro',
        shippingMethodPreference: 'own_van',
        locationUrl: 'https://maps.example/x',
      },
      null,
    );
    expect(customer.managerName).toBe('استاذ مصطفي');
    expect(customer.governorate).toBe('الغربيه');
    expect(customer.whatsappPhone).toBe('01067100334');
    expect(customer.locationUrl).toBe('https://maps.example/x');
  });

  function importRow(overrides: Partial<Record<string, string>> = {}) {
    return {
      name: '', managerName: '', address: '', governorate: '', classification: '', phone: '', whatsappPhone: '',
      salesRepName: '', contactMethod: '', responsivenessLevel: '', disinterestNotes: '', priceSatisfactionLevel: '',
      topBrand: '', midBrand: '', lowBrand: '', shippingMethodPreference: '', locationUrl: '', ...overrides,
    };
  }

  it('import: matches the Sales Rep by NAME (the real sheet has no email column) and assigns + classifies', async () => {
    const { succeeded, rejected } = await service.importRows(
      [importRow({ name: 'Aylin Restaurant & cafe', salesRepName: 'ا حسين', classification: 'A', governorate: 'الغربيه' })],
      'importer-1',
    );
    expect(rejected).toEqual([]);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].classification).toBe('A');
    expect(succeeded[0].governorate).toBe('الغربيه');
    expect(assignments).toHaveLength(1);
    expect(assignments[0].salesRepUserId).toBe('rep-1');
  });

  it('import: rejects the whole row (no customer created) when the rep name doesn\'t match exactly one user', async () => {
    const { succeeded, rejected } = await service.importRows(
      [importRow({ name: 'Some Cafe', salesRepName: 'Unknown Rep Name' })],
      'importer-1',
    );
    expect(succeeded).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].errors[0]).toContain('Unknown Rep Name');
  });

  it('import: a blank Sales Rep column creates the customer with no assignment, no error', async () => {
    const { succeeded, rejected } = await service.importRows([importRow({ name: 'No Rep Yet Co.' })], 'importer-1');
    expect(rejected).toEqual([]);
    expect(succeeded).toHaveLength(1);
    expect(assignments).toHaveLength(0);
  });
});
