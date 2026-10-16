import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Customer } from '../infrastructure/customer.entity';
import { CustomerAddress } from '../infrastructure/customer-address.entity';
import { CustomerContact } from '../infrastructure/customer-contact.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { PROFILE_LANGUAGES, profileEmail as email, profileOneOf as oneOf, profileText as text, profileWebsite } from '../../../foundation/profile/profile-validation';

/**
 * Customer profile (master-data gap matrix §5, M4/M5) — the descriptive "who is this customer" data: legal identity, tax numbers, e-mail,
 * website, language, internal notes, an address book and contact persons. It is deliberately separate from `CustomersService` (which owns
 * the lifecycle, workflow policy, price list, assignment and financial settings): nothing here touches status, credit, price list or any
 * ledger, and no snapshot/contract consumed by sales orders, invoices or payments reads these columns, so order and ledger behaviour is
 * unchanged. Scope/permission checks stay in the controller (the existing `getCustomer` scope check + `sales.customer.edit`).
 *
 * Partial-update semantics, same as the rest of the CRM: a field that is `undefined` is left untouched; an empty/blank string clears it.
 * One default address and one primary contact per customer — enforced by partial unique indexes and by clearing the previous holder inside
 * the same transaction, so two concurrent writers cannot both win.
 */

export const PARTY_TYPES = ['company', 'individual'] as const;

export interface UpdateCustomerProfileInput {
  name?: string;
  phone?: string | null;
  whatsappPhone?: string | null;
  managerName?: string | null;
  address?: string | null;
  governorate?: string | null;
  partyType?: string | null;
  legalName?: string | null;
  taxRegistrationNumber?: string | null;
  vatRegistrationNumber?: string | null;
  commercialRegistrationNumber?: string | null;
  email?: string | null;
  website?: string | null;
  language?: string | null;
  internalNotes?: string | null;
}

export interface CustomerContactInput {
  name?: string;
  title?: string | null;
  phone?: string | null;
  email?: string | null;
  isPrimary?: boolean;
}

export interface CustomerAddressInput {
  label?: string | null;
  addressLine?: string;
  city?: string | null;
  governorate?: string | null;
  isDefault?: boolean;
  isBilling?: boolean;
  isShipping?: boolean;
}

@Injectable()
export class CustomerProfileService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private runner(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  private async requireCustomer(customerId: string, manager?: EntityManager): Promise<Customer> {
    const customer = await this.runner(manager).getRepository(Customer).findOne({ where: { id: customerId } });
    if (!customer) throw new NotFoundException(`Customer "${customerId}" not found.`);
    return customer;
  }

  /** A unique-index race (two writers claiming the one default/primary slot) is a conflict, not a server error. */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof QueryFailedError && (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505') {
        throw new ConflictException('Another change to this customer\'s default/primary entry was made at the same time — reload and try again.');
      }
      throw err;
    }
  }

  async getProfile(customerId: string, manager?: EntityManager): Promise<{ customer: Customer; addresses: CustomerAddress[]; contacts: CustomerContact[] }> {
    const run = this.runner(manager);
    const customer = await this.requireCustomer(customerId, manager);
    const [addresses, contacts] = await Promise.all([
      run.getRepository(CustomerAddress).find({ where: { customerId }, order: { isDefault: 'DESC', createdAt: 'ASC' } }),
      run.getRepository(CustomerContact).find({ where: { customerId }, order: { isPrimary: 'DESC', createdAt: 'ASC' } }),
    ]);
    return { customer, addresses, contacts };
  }

  async updateProfile(customerId: string, input: UpdateCustomerProfileInput, actorUserId: string | null, manager?: EntityManager): Promise<Customer> {
    // Validate everything BEFORE reading or writing anything.
    const next: Partial<Record<keyof UpdateCustomerProfileInput, string | null | undefined>> = {
      name: input.name === undefined ? undefined : text('name', input.name, 255) ?? undefined,
      phone: text('phone', input.phone, 32),
      whatsappPhone: text('whatsappPhone', input.whatsappPhone, 32),
      managerName: text('managerName', input.managerName, 255),
      address: text('address', input.address, 500),
      governorate: text('governorate', input.governorate, 128),
      partyType: oneOf('partyType', input.partyType, PARTY_TYPES),
      legalName: text('legalName', input.legalName, 255),
      taxRegistrationNumber: text('taxRegistrationNumber', input.taxRegistrationNumber, 64),
      vatRegistrationNumber: text('vatRegistrationNumber', input.vatRegistrationNumber, 64),
      commercialRegistrationNumber: text('commercialRegistrationNumber', input.commercialRegistrationNumber, 64),
      email: email(input.email),
      website: profileWebsite(input.website),
      language: oneOf('language', input.language, PROFILE_LANGUAGES),
      internalNotes: text('internalNotes', input.internalNotes, 4000),
    };
    if (input.name !== undefined && next.name === undefined) throw new BadRequestException('"name" cannot be empty.');

    const repo = this.runner(manager).getRepository(Customer);
    const customer = await this.requireCustomer(customerId, manager);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      const current = (customer as unknown as Record<string, unknown>)[key] ?? null;
      if (current === value) continue;
      before[key] = current;
      after[key] = value;
      (customer as unknown as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(after).length === 0) return customer; // nothing changed — no write, no audit noise

    const saved = await repo.save(customer);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.profile_updated', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, before, after },
      manager,
    );
    return saved;
  }

  // ---- contacts ----

  async addContact(customerId: string, input: CustomerContactInput, actorUserId: string | null, manager?: EntityManager): Promise<CustomerContact> {
    const name = text('name', input.name, 255);
    if (!name) throw new BadRequestException('A contact needs a name.');
    const fields = { name, title: text('title', input.title, 128) ?? null, phone: text('phone', input.phone, 32) ?? null, email: email(input.email) ?? null };
    await this.requireCustomer(customerId, manager);
    const saved = await this.guard(() =>
      this.runner(manager).transaction(async (tx) => {
        const repo = tx.getRepository(CustomerContact);
        if (input.isPrimary) await repo.update({ customerId }, { isPrimary: false });
        return repo.save(repo.create({ customerId, ...fields, isPrimary: input.isPrimary === true }));
      }),
    );
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.contact_added', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, after: { contactId: saved.id, name: saved.name, isPrimary: saved.isPrimary } },
      manager,
    );
    return saved;
  }

  async updateContact(customerId: string, contactId: string, input: CustomerContactInput, actorUserId: string | null, manager?: EntityManager): Promise<CustomerContact> {
    const patch: Partial<CustomerContact> = {};
    if (input.name !== undefined) {
      const name = text('name', input.name, 255);
      if (!name) throw new BadRequestException('A contact needs a name.');
      patch.name = name;
    }
    const title = text('title', input.title, 128);
    if (title !== undefined) patch.title = title;
    const phone = text('phone', input.phone, 32);
    if (phone !== undefined) patch.phone = phone;
    const mail = email(input.email);
    if (mail !== undefined) patch.email = mail;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;

    const saved = await this.guard(() =>
      this.runner(manager).transaction(async (tx) => {
        const repo = tx.getRepository(CustomerContact);
        const contact = await repo.findOne({ where: { id: contactId, customerId } });
        if (!contact) throw new NotFoundException(`Contact "${contactId}" not found on this customer.`);
        if (patch.isPrimary) await repo.update({ customerId }, { isPrimary: false });
        return repo.save(Object.assign(contact, patch));
      }),
    );
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.contact_updated', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, after: { contactId, ...patch } },
      manager,
    );
    return saved;
  }

  async removeContact(customerId: string, contactId: string, actorUserId: string | null, manager?: EntityManager): Promise<{ removed: boolean }> {
    const result = await this.runner(manager).getRepository(CustomerContact).delete({ id: contactId, customerId });
    if (!result.affected) throw new NotFoundException(`Contact "${contactId}" not found on this customer.`);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.contact_removed', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, after: { contactId } },
      manager,
    );
    return { removed: true };
  }

  // ---- addresses ----

  async addAddress(customerId: string, input: CustomerAddressInput, actorUserId: string | null, manager?: EntityManager): Promise<CustomerAddress> {
    const addressLine = text('addressLine', input.addressLine, 500);
    if (!addressLine) throw new BadRequestException('An address needs an address line.');
    const fields = {
      label: text('label', input.label, 128) ?? null,
      addressLine,
      city: text('city', input.city, 128) ?? null,
      governorate: text('governorate', input.governorate, 128) ?? null,
      isBilling: input.isBilling === true,
      isShipping: input.isShipping === true,
    };
    await this.requireCustomer(customerId, manager);
    const saved = await this.guard(() =>
      this.runner(manager).transaction(async (tx) => {
        const repo = tx.getRepository(CustomerAddress);
        if (input.isDefault) await repo.update({ customerId }, { isDefault: false });
        return repo.save(repo.create({ customerId, ...fields, isDefault: input.isDefault === true }));
      }),
    );
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.address_added', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, after: { addressId: saved.id, addressLine: saved.addressLine, isDefault: saved.isDefault } },
      manager,
    );
    return saved;
  }

  async updateAddress(customerId: string, addressId: string, input: CustomerAddressInput, actorUserId: string | null, manager?: EntityManager): Promise<CustomerAddress> {
    const patch: Partial<CustomerAddress> = {};
    if (input.addressLine !== undefined) {
      const line = text('addressLine', input.addressLine, 500);
      if (!line) throw new BadRequestException('An address needs an address line.');
      patch.addressLine = line;
    }
    const label = text('label', input.label, 128);
    if (label !== undefined) patch.label = label;
    const city = text('city', input.city, 128);
    if (city !== undefined) patch.city = city;
    const governorate = text('governorate', input.governorate, 128);
    if (governorate !== undefined) patch.governorate = governorate;
    if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
    if (input.isBilling !== undefined) patch.isBilling = input.isBilling;
    if (input.isShipping !== undefined) patch.isShipping = input.isShipping;

    const saved = await this.guard(() =>
      this.runner(manager).transaction(async (tx) => {
        const repo = tx.getRepository(CustomerAddress);
        const address = await repo.findOne({ where: { id: addressId, customerId } });
        if (!address) throw new NotFoundException(`Address "${addressId}" not found on this customer.`);
        if (patch.isDefault) await repo.update({ customerId }, { isDefault: false });
        return repo.save(Object.assign(address, patch));
      }),
    );
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.address_updated', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, after: { addressId, ...patch } },
      manager,
    );
    return saved;
  }

  async removeAddress(customerId: string, addressId: string, actorUserId: string | null, manager?: EntityManager): Promise<{ removed: boolean }> {
    const result = await this.runner(manager).getRepository(CustomerAddress).delete({ id: addressId, customerId });
    if (!result.affected) throw new NotFoundException(`Address "${addressId}" not found on this customer.`);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'crm.customer.address_removed', resource: 'customer', resourceId: customerId, result: 'success', correlationId: null, after: { addressId } },
      manager,
    );
    return { removed: true };
  }
}
