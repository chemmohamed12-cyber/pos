import { ModuleManifest } from '../module-manifest.type';
import { salesManifest } from './sales.manifest';
import { inventoryManifest } from './inventory.manifest';
import { logisticsManifest } from './logistics.manifest';
import { financeManifest } from './finance.manifest';
import { reportingManifest } from './reporting.manifest';
import { hrManifest } from './hr.manifest';
import { accountingManifest } from './accounting.manifest';

/**
 * ERP Foundation — P1 (5 V1 module manifests) + P9/ADR-029 (`hr`, the 6th)
 * + F01/ADR-032 (`accounting`, the 7th — Financial Core).
 * `core` has no authored manifest (always active, never gated — ADR-024 §2.1).
 */
export const ALL_MODULE_MANIFESTS: readonly ModuleManifest[] = [
  salesManifest,
  inventoryManifest,
  logisticsManifest,
  financeManifest,
  reportingManifest,
  hrManifest,
  accountingManifest,
];

export { salesManifest, inventoryManifest, logisticsManifest, financeManifest, reportingManifest, hrManifest, accountingManifest };
