import { ConfigScopeLevel, ConfigValueType } from './config-key.entity';

/**
 * The code-level shape a config key is declared in — by CORE_CONFIG_KEYS
 * (this module) or by a module manifest's `config_keys[]` (ADR-024, P1).
 * The seeder (config-registry.seeder.ts) upserts these into `config_keys`.
 */
export interface ConfigKeySource {
  key: string;
  ownerModule: string; // ModuleCode
  valueType: ConfigValueType;
  allowed?: readonly unknown[] | { min: number; max: number };
  default: unknown;
  scopeLevels: readonly ConfigScopeLevel[];
  platformLocked?: boolean;
  securitySensitive?: boolean;
  isFeatureFlag?: boolean;
  titleCode: string;
  description?: string;
  flagOwner?: string;
  flagRemoveBy?: string; // YYYY-MM-DD
  /** Set to a reason string to allow securitySensitive without platformLocked (CFG-5). */
  justifiedUnlocked?: string;
}
