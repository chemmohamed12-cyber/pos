import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SupplierContact } from '../infrastructure/supplier-contact.entity';
import { SupplierAddress } from '../infrastructure/supplier-address.entity';
import { AuditService } from '../../../foundation/audit/audit.service';
import { profileEmail, profileText } from '../../../foundation/profile/profile-validation';

/**
 * Supplier profile (master-data gap matrix §5) — change and remove a supplier's contact persons and addresses. `SupplierService` already
 * creates them (and the add paths now keep exactly one primary contact / one default address); this closes the gap that a wrong entry could
 * never be corrected. Supplier master data only: it touches no payable, invoice, payment or bank-account record (bank accounts stay
 * approval-gated in `SupplierService`). Partial-update semantics: `undefined` untouched, blank clears. Every change is audited.
 */
export interface SupplierContactPatch {
  name?: string;
  title?: string | null;
  phone?: string | null;
  email?: string | null;
  isPrimary?: boolean;
}

export interface SupplierAddressPatch {
  label?: string | null;
  addressLine?: string;
  city?: string | null;
  governorate?: string | null;
  isDefault?: boolean;
}

@Injectable()
export class SupplierProfileService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  private em(manager?: EntityManager): EntityManager {
    return manager ?? this.dataSource.manager;
  }

  private inTransaction<T>(manager: EntityManager | undefined, run: (tx: EntityManager) => Promise<T>): Promise<T> {
    const em = this.em(manager);
    return em.queryRunner?.isTransactionActive ? run(em) : em.transaction(run);
  }

  async updateContact(supplierId: string, contactId: string, input: SupplierContactPatch, actorUserId: string, manager?: EntityManager): Promise<SupplierContact> {
    const patch: Partial<SupplierContact> = {};
    if (input.name !== undefined) {
      const name = profileText('name', input.name, 255);
      if (!name) throw new BadRequestException('A contact needs a name.');
      patch.name = name;
    }
    const title = profileText('title', input.title, 128);
    if (title !== undefined) patch.title = title;
    const phone = profileText('phone', input.phone, 32);
    if (phone !== undefined) patch.phone = phone;
    const email = profileEmail(input.email);
    if (email !== undefined) patch.email = email;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;

    const saved = await this.inTransaction(manager, async (tx) => {
      const repo = tx.getRepository(SupplierContact);
      const contact = await repo.findOne({ where: { id: contactId, supplierId } });
      if (!contact) throw new NotFoundException(`Contact "${contactId}" not found on this supplier.`);
      if (patch.isPrimary) await repo.update({ supplierId }, { isPrimary: false });
      return repo.save(Object.assign(contact, patch));
    });
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'supplier.contact_updated', resource: 'supplier', resourceId: supplierId, result: 'success', correlationId: supplierId, after: { contactId, ...patch } },
      manager,
    );
    return saved;
  }

  async removeContact(supplierId: string, contactId: string, actorUserId: string, manager?: EntityManager): Promise<{ removed: boolean }> {
    const result = await this.em(manager).getRepository(SupplierContact).delete({ id: contactId, supplierId });
    if (!result.affected) throw new NotFoundException(`Contact "${contactId}" not found on this supplier.`);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'supplier.contact_removed', resource: 'supplier', resourceId: supplierId, result: 'success', correlationId: supplierId, after: { contactId } },
      manager,
    );
    return { removed: true };
  }

  async updateAddress(supplierId: string, addressId: string, input: SupplierAddressPatch, actorUserId: string, manager?: EntityManager): Promise<SupplierAddress> {
    const patch: Partial<SupplierAddress> = {};
    if (input.addressLine !== undefined) {
      const line = profileText('addressLine', input.addressLine, 500);
      if (!line) throw new BadRequestException('An address needs an address line.');
      patch.addressLine = line;
    }
    const label = profileText('label', input.label, 128);
    if (label !== undefined) patch.label = label;
    const city = profileText('city', input.city, 128);
    if (city !== undefined) patch.city = city;
    const governorate = profileText('governorate', input.governorate, 128);
    if (governorate !== undefined) patch.governorate = governorate;
    if (input.isDefault !== undefined) patch.isDefault = input.isDefault;

    const saved = await this.inTransaction(manager, async (tx) => {
      const repo = tx.getRepository(SupplierAddress);
      const address = await repo.findOne({ where: { id: addressId, supplierId } });
      if (!address) throw new NotFoundException(`Address "${addressId}" not found on this supplier.`);
      if (patch.isDefault) await repo.update({ supplierId }, { isDefault: false });
      return repo.save(Object.assign(address, patch));
    });
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'supplier.address_updated', resource: 'supplier', resourceId: supplierId, result: 'success', correlationId: supplierId, after: { addressId, ...patch } },
      manager,
    );
    return saved;
  }

  async removeAddress(supplierId: string, addressId: string, actorUserId: string, manager?: EntityManager): Promise<{ removed: boolean }> {
    const result = await this.em(manager).getRepository(SupplierAddress).delete({ id: addressId, supplierId });
    if (!result.affected) throw new NotFoundException(`Address "${addressId}" not found on this supplier.`);
    await this.audit.record(
      { actorUserId, organizationId: null, action: 'supplier.address_removed', resource: 'supplier', resourceId: supplierId, result: 'success', correlationId: supplierId, after: { addressId } },
      manager,
    );
    return { removed: true };
  }
}
