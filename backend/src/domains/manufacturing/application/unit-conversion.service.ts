import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ProductUnitConversion } from '../infrastructure/product-unit-conversion.entity';

const UNIT_CODE = /^[^\s]{1,32}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Manufacturing Engine S2 (decision D-ME-2) — fractional quantities by integer base-unit scaling. Stock and valuation keep their integer base unit (`products.unit`);
 * this service only converts a quantity typed in another unit into whole base units and REFUSES any conversion that is not exact (nothing is rounded silently).
 * Pure exact decimal arithmetic on strings/BigInt — no floating point.
 */
@Injectable()
export class UnitConversionService {
  private async baseUnit(productId: string, manager: EntityManager): Promise<string> {
    const rows: Array<{ unit: string | null }> = await manager.query(`SELECT "unit" FROM "products" WHERE "id" = $1`, [productId]);
    if (rows.length === 0) throw new NotFoundException(`Product "${productId}" not found.`);
    return (rows[0].unit ?? '').trim();
  }

  async list(productId: string, manager: EntityManager): Promise<{ baseUnit: string; conversions: ProductUnitConversion[] }> {
    const baseUnit = await this.baseUnit(productId, manager);
    const conversions = await manager.getRepository(ProductUnitConversion).find({ where: { productId }, order: { factor: 'ASC' } });
    return { baseUnit, conversions };
  }

  async set(productId: string, unitCode: string, factor: number, actorUserId: string | null, manager: EntityManager): Promise<ProductUnitConversion> {
    const code = (unitCode ?? '').trim();
    if (!UNIT_CODE.test(code)) throw new BadRequestException('A unit code is required (no spaces, max 32 characters).');
    if (!Number.isInteger(factor) || factor < 2) throw new BadRequestException('The factor must be a whole number of base units, at least 2.');
    const base = await this.baseUnit(productId, manager);
    if (code.toLowerCase() === base.toLowerCase()) throw new ConflictException(`"${code}" is already the base unit of this product.`);
    const repo = manager.getRepository(ProductUnitConversion);
    const existing = (await repo.find({ where: { productId } })).find((c) => c.unitCode.toLowerCase() === code.toLowerCase());
    if (existing) {
      existing.factor = factor;
      return repo.save(existing);
    }
    return repo.save(repo.create({ productId, unitCode: code, factor, createdByUserId: actorUserId }));
  }

  async remove(productId: string, unitCode: string, manager: EntityManager): Promise<void> {
    const repo = manager.getRepository(ProductUnitConversion);
    const row = (await repo.find({ where: { productId } })).find((c) => c.unitCode.toLowerCase() === (unitCode ?? '').trim().toLowerCase());
    if (!row) throw new NotFoundException(`Unit "${unitCode}" is not defined for product "${productId}".`);
    await repo.delete(row.id);
  }

  /** `quantity` typed in `unitCode` (null/blank/base unit = already base) -> whole base units. Throws unless the result is an exact positive integer. */
  async toBase(productId: string, quantity: string | number, unitCode: string | null | undefined, manager: EntityManager): Promise<number> {
    const q = String(quantity).trim();
    if (!DECIMAL.test(q)) throw new BadRequestException(`"${quantity}" is not a valid quantity.`);
    const code = (unitCode ?? '').trim();
    const base = await this.baseUnit(productId, manager);
    let factor = 1n;
    if (code !== '' && code.toLowerCase() !== base.toLowerCase()) {
      const conv = (await manager.getRepository(ProductUnitConversion).find({ where: { productId } })).find((c) => c.unitCode.toLowerCase() === code.toLowerCase());
      if (!conv) throw new ConflictException(`Unit "${code}" is not defined for product "${productId}" (base unit "${base}").`);
      factor = BigInt(conv.factor);
    }
    const [whole, frac = ''] = q.split('.');
    const scale = 10n ** BigInt(frac.length);
    const numerator = BigInt(whole + frac) * factor;
    if (numerator % scale !== 0n) {
      throw new ConflictException(`${q} ${code || base} is not a whole number of base units (${base}); define a smaller base unit or a different quantity.`);
    }
    const result = numerator / scale;
    if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw new BadRequestException('The converted quantity must be a positive whole number of base units.');
    return Number(result);
  }

  /** Whole base units -> a display string in `unitCode` (exact decimal; base unit returns the integer). */
  async fromBase(productId: string, baseQuantity: number, unitCode: string | null | undefined, manager: EntityManager): Promise<string> {
    const code = (unitCode ?? '').trim();
    const base = await this.baseUnit(productId, manager);
    if (code === '' || code.toLowerCase() === base.toLowerCase()) return String(baseQuantity);
    const conv = (await manager.getRepository(ProductUnitConversion).find({ where: { productId } })).find((c) => c.unitCode.toLowerCase() === code.toLowerCase());
    if (!conv) throw new ConflictException(`Unit "${code}" is not defined for product "${productId}".`);
    const whole = Math.trunc(baseQuantity / conv.factor);
    const rem = baseQuantity % conv.factor;
    if (rem === 0) return String(whole);
    const digits = String(conv.factor).length;
    const fracStr = ((BigInt(rem) * 10n ** BigInt(digits + 2)) / BigInt(conv.factor)).toString().padStart(digits + 2, '0').replace(/0+$/, '');
    return `${whole}.${fracStr || '0'}`;
  }
}
