/**
 * ERP Foundation — P1. Module Registry barrel.
 *
 * Nothing here is imported by the running application in P1. Consumers:
 *   - tools/validation/validate-module-manifests.js (CI)
 *   - module-registry.spec.ts / require-*.spec.ts (unit tests)
 *   - (from P3) the Entitlement Engine, when it becomes a Nest provider.
 */
export * from './module-manifest.type';
export * from './module-registry';
export * from './require-module.decorator';
export * from './require-feature.decorator';
export { ALL_MODULE_MANIFESTS } from './manifests';
