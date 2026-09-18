import { ConfigValueType } from './config-key.entity';

/**
 * Text <-> typed coercion + validation for config values. Pure. P2_BLUEPRINT §8.
 * Stored form is ALWAYS text; this is the single place it becomes/leaves a
 * typed JS value.
 */

export type NumericRange = { min: number; max: number };

export interface CoerceOptions {
  type: ConfigValueType;
  allowed?: unknown; // string[] for enum, {min,max} for int/decimal
}

/** Coerce a stored text value to its typed JS form. Throws on a value that no longer fits. */
export function coerce(raw: string, opts: CoerceOptions): unknown {
  switch (opts.type) {
    case 'bool': {
      const v = raw.trim().toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      throw new ConfigCoerceError(`not a boolean: ${JSON.stringify(raw)}`);
    }
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ConfigCoerceError(`not an integer: ${JSON.stringify(raw)}`);
      assertRange(n, opts.allowed);
      return n;
    }
    case 'decimal': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ConfigCoerceError(`not a number: ${JSON.stringify(raw)}`);
      assertRange(n, opts.allowed);
      return n;
    }
    case 'enum': {
      const list = Array.isArray(opts.allowed) ? (opts.allowed as unknown[]).map(String) : [];
      if (!list.includes(raw)) throw new ConfigCoerceError(`${JSON.stringify(raw)} not in enum [${list.join(', ')}]`);
      return raw;
    }
    case 'json': {
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new ConfigCoerceError(`not valid JSON: ${(e as Error).message}`);
      }
    }
    case 'string': {
      if (raw.length > 4096) throw new ConfigCoerceError('string exceeds 4096 chars');
      return raw;
    }
    default:
      throw new ConfigCoerceError(`unknown value type: ${String(opts.type)}`);
  }
}

/** Serialize a typed JS value to its stored text form. Validates the same rules as `coerce`. */
export function serialize(value: unknown, opts: CoerceOptions): string {
  switch (opts.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new ConfigCoerceError('expected a boolean');
      return value ? 'true' : 'false';
    case 'int': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n)) throw new ConfigCoerceError('expected an integer');
      assertRange(n, opts.allowed);
      return String(n);
    }
    case 'decimal': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw new ConfigCoerceError('expected a number');
      assertRange(n, opts.allowed);
      return String(n);
    }
    case 'enum': {
      const s = String(value);
      const list = Array.isArray(opts.allowed) ? (opts.allowed as unknown[]).map(String) : [];
      if (!list.includes(s)) throw new ConfigCoerceError(`${JSON.stringify(s)} not in enum [${list.join(', ')}]`);
      return s;
    }
    case 'json': {
      const s = JSON.stringify(value);
      if (s === undefined) throw new ConfigCoerceError('value is not JSON-serializable');
      return s;
    }
    case 'string': {
      const s = typeof value === 'string' ? value : String(value);
      if (s.length > 4096) throw new ConfigCoerceError('string exceeds 4096 chars');
      return s;
    }
    default:
      throw new ConfigCoerceError(`unknown value type: ${String(opts.type)}`);
  }
}

/** SECURE_CODING_STANDARD.md §14 / ADR-023 C5 — secrets never live in config_values. */
const SECRET_SHAPE = /(secret|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key|-----BEGIN)/i;
export function looksLikeSecret(rawText: string): boolean {
  return SECRET_SHAPE.test(rawText);
}

function assertRange(n: number, allowed: unknown): void {
  if (allowed && typeof allowed === 'object' && 'min' in allowed && 'max' in allowed) {
    const { min, max } = allowed as NumericRange;
    if (n < min || n > max) throw new ConfigCoerceError(`${n} out of range [${min}, ${max}]`);
  }
}

export class ConfigCoerceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCoerceError';
  }
}
