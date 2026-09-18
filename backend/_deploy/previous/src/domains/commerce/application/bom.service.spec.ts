import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BomService } from './bom.service';
import { BillOfMaterial } from '../infrastructure/bill-of-materials.entity';
import { BomComponent } from '../infrastructure/bom-component.entity';
import { ProductsService } from './products.service';
import { AuditService } from '../../../foundation/audit/audit.service';

/** Gap G-2 — BOM definition, replace-on-redefine, and the cross-domain read Inventory consumes for assembly. */
describe('BomService', () => {
  let service: BomService;
  const boms = new Map<string, BillOfMaterial>();
  const components = new Map<string, BomComponent>();
  let idSeq = 0;

  const bomRepoMock = () => ({
    create: jest.fn((data: Partial<BillOfMaterial>) => ({ id: `bom-${++idSeq}`, ...data }) as BillOfMaterial),
    save: jest.fn(async (data: Partial<BillOfMaterial>) => {
      const saved = { id: data.id ?? `bom-${++idSeq}`, ...data } as BillOfMaterial;
      boms.set(saved.id, saved);
      return saved;
    }),
    findOne: jest.fn(async ({ where }: { where: { finishedProductId: string } }) =>
      [...boms.values()].find((b) => b.finishedProductId === where.finishedProductId) ?? null,
    ),
    find: jest.fn(async () => [...boms.values()]),
    remove: jest.fn(async (b: BillOfMaterial) => {
      boms.delete(b.id);
      for (const c of [...components.values()]) if (c.billOfMaterialId === b.id) components.delete(c.id);
      return b;
    }),
  });

  const componentRepoMock = () => ({
    create: jest.fn((data: Partial<BomComponent>) => ({ id: `comp-${++idSeq}`, ...data }) as BomComponent),
    save: jest.fn(async (input: BomComponent | BomComponent[]) => {
      const arr = Array.isArray(input) ? input : [input];
      arr.forEach((c) => components.set(c.id, c));
      return arr;
    }),
    delete: jest.fn(async ({ billOfMaterialId }: { billOfMaterialId: string }) => {
      for (const c of [...components.values()]) if (c.billOfMaterialId === billOfMaterialId) components.delete(c.id);
    }),
    find: jest.fn(async ({ where }: { where: { billOfMaterialId: string } }) =>
      [...components.values()].filter((c) => c.billOfMaterialId === where.billOfMaterialId),
    ),
  });

  const getRepositoryMock = jest.fn((entity: unknown) => (entity === BillOfMaterial ? bomRepoMock() : componentRepoMock()));
  const dataSourceMock = {
    getRepository: getRepositoryMock,
    transaction: jest.fn(async (fn: (manager: unknown) => Promise<unknown>) => fn({ getRepository: getRepositoryMock })),
  };

  const auditMock = { record: jest.fn(async () => undefined) };
  const productsMock = {
    getProductSnapshot: jest.fn(async (id: string) =>
      id === 'missing-product' ? null : { id, sku: `SKU-${id}`, name: `Product ${id}`, unitPrice: '10.00', status: 'active' },
    ),
  };

  beforeEach(async () => {
    boms.clear();
    components.clear();
    idSeq = 0;
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BomService,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: AuditService, useValue: auditMock },
        { provide: ProductsService, useValue: productsMock },
      ],
    }).compile();
    service = moduleRef.get(BomService);
  });

  it('defines a BOM with its components', async () => {
    const bom = await service.defineBom('finished-1', [{ componentProductId: 'comp-a', quantityPerUnit: 2 }], 'actor-1');
    const view = await service.getBom('finished-1');
    expect(view?.components).toHaveLength(1);
    expect(view?.components[0]).toMatchObject({ componentProductId: 'comp-a', quantityPerUnit: 2 });
    expect(bom.finishedProductId).toBe('finished-1');
  });

  it('rejects an empty component list', async () => {
    await expect(service.defineBom('finished-1', [], 'actor-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a product being a component of its own BOM', async () => {
    await expect(
      service.defineBom('finished-1', [{ componentProductId: 'finished-1', quantityPerUnit: 1 }], 'actor-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate component within the same submission', async () => {
    await expect(
      service.defineBom(
        'finished-1',
        [
          { componentProductId: 'comp-a', quantityPerUnit: 1 },
          { componentProductId: 'comp-a', quantityPerUnit: 2 },
        ],
        'actor-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-positive quantityPerUnit', async () => {
    await expect(
      service.defineBom('finished-1', [{ componentProductId: 'comp-a', quantityPerUnit: 0 }], 'actor-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown component product', async () => {
    await expect(
      service.defineBom('finished-1', [{ componentProductId: 'missing-product', quantityPerUnit: 1 }], 'actor-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('redefining a BOM replaces the component set entirely, never accumulating', async () => {
    await service.defineBom('finished-1', [{ componentProductId: 'comp-a', quantityPerUnit: 1 }], 'actor-1');
    await service.defineBom('finished-1', [{ componentProductId: 'comp-b', quantityPerUnit: 5 }], 'actor-1');
    const view = await service.getBom('finished-1');
    expect(view?.components).toHaveLength(1);
    expect(view?.components[0]).toMatchObject({ componentProductId: 'comp-b', quantityPerUnit: 5 });
  });

  it('getBom returns null for a product with no BOM defined', async () => {
    expect(await service.getBom('no-such-product')).toBeNull();
  });

  it('getBomForAssembly returns null when no BOM is defined (never throws — Inventory turns this into its own business error)', async () => {
    expect(await service.getBomForAssembly('no-such-product')).toBeNull();
  });

  it('getBomForAssembly returns the flat recipe Inventory consumes', async () => {
    await service.defineBom('finished-1', [{ componentProductId: 'comp-a', quantityPerUnit: 3 }], 'actor-1');
    expect(await service.getBomForAssembly('finished-1')).toEqual([{ componentProductId: 'comp-a', quantityPerUnit: 3 }]);
  });

  it('deletes a BOM', async () => {
    await service.defineBom('finished-1', [{ componentProductId: 'comp-a', quantityPerUnit: 1 }], 'actor-1');
    await service.deleteBom('finished-1', 'actor-1');
    expect(await service.getBom('finished-1')).toBeNull();
  });

  it('deleteBom 404s for a product with no BOM', async () => {
    await expect(service.deleteBom('no-such-product', 'actor-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
