import { AppConfigService } from './app-config.service';
import { configurationValidationSchema as configurationSchema } from './configuration.schema';

/**
 * The SAFE DEFAULT of the Company migration gate (CTO 2026-10-21): nobody has to remember to set RELEASE_COMPANY_MIGRATIONS. Unset means `on` on the staged path (the
 * default path), `off` only where the legacy path makes `on` impossible; an explicit value always wins and is reported as explicit.
 */
function config(values: Record<string, unknown>): AppConfigService {
  const fake = { get: (k: string) => values[k] };
  return new AppConfigService(fake as never);
}

describe('RELEASE_COMPANY_MIGRATIONS effective default', () => {
  it('unset + staged activation (the default) => on, reported as NOT explicit', () => {
    const d = config({ RELEASE_STAGED_ACTIVATION: true }).releaseDeploy;
    expect(d.companyMigrations).toBe('on');
    expect(d.companyMigrationsExplicit).toBe(false);
  });
  it('unset and RELEASE_STAGED_ACTIVATION not set at all => still on (the schema default for staged activation is true)', () => {
    expect(config({}).releaseDeploy.companyMigrations).toBe('on');
  });
  it('unset + legacy in-place path => off (the legacy path has no pre-swap point), still not explicit', () => {
    const d = config({ RELEASE_STAGED_ACTIVATION: false }).releaseDeploy;
    expect(d.companyMigrations).toBe('off');
    expect(d.companyMigrationsExplicit).toBe(false);
  });
  it.each(['off', 'dry-run', 'on'] as const)('explicit %s always wins and is reported as explicit', (mode) => {
    const d = config({ RELEASE_COMPANY_MIGRATIONS: mode, RELEASE_STAGED_ACTIVATION: true }).releaseDeploy;
    expect(d.companyMigrations).toBe(mode);
    expect(d.companyMigrationsExplicit).toBe(true);
  });
  it('the skipped-Company policy defaults to block and the schema check to enforce', () => {
    const d = config({}).releaseDeploy;
    expect(d.companySkippedPolicy).toBe('block');
    expect(d.companySchemaCheck).toBe('enforce');
    const o = config({ RELEASE_COMPANY_SKIPPED_POLICY: 'allow', RELEASE_COMPANY_SCHEMA_CHECK: 'report' }).releaseDeploy;
    expect(o.companySkippedPolicy).toBe('allow');
    expect(o.companySchemaCheck).toBe('report');
  });
});

describe('configuration schema', () => {
  const validate = (env: Record<string, unknown>) => configurationSchema.validate(env, { allowUnknown: true, abortEarly: false });
  it('RELEASE_COMPANY_MIGRATIONS has NO schema default (the effective default is resolved by the config service so "unset" stays distinguishable from "off")', () => {
    const { value } = validate({});
    expect(value.RELEASE_COMPANY_MIGRATIONS).toBeUndefined();
  });
  it('accepts exactly off | dry-run | on', () => {
    for (const ok of ['off', 'dry-run', 'on']) expect(validate({ RELEASE_COMPANY_MIGRATIONS: ok }).error?.message ?? '').not.toContain('RELEASE_COMPANY_MIGRATIONS');
    expect(validate({ RELEASE_COMPANY_MIGRATIONS: 'maybe' }).error?.message).toContain('RELEASE_COMPANY_MIGRATIONS');
  });
  it('the policy settings validate and default', () => {
    const { value } = validate({});
    expect(value.RELEASE_COMPANY_SKIPPED_POLICY).toBe('block');
    expect(value.RELEASE_COMPANY_SCHEMA_CHECK).toBe('enforce');
    expect(validate({ RELEASE_COMPANY_SKIPPED_POLICY: 'sometimes' }).error?.message).toContain('RELEASE_COMPANY_SKIPPED_POLICY');
  });
});
