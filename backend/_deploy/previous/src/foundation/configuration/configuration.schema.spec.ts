import { configurationValidationSchema } from './configuration.schema';

/**
 * Proportional test coverage per CTO Execution Directive §6: main
 * success path, main failure path, and the one critical invariant this
 * capability exists to enforce (no dev-secret default in production).
 */
describe('configurationValidationSchema', () => {
  const validEnv = {
    NODE_ENV: 'development',
    DB_HOST: 'localhost',
    DB_USER: 'daii',
    DB_NAME: 'daii_dev',
  };

  it('accepts a valid development config and applies safe defaults', () => {
    const { error, value } = configurationValidationSchema.validate(validEnv);
    expect(error).toBeUndefined();
    expect(value.PORT).toBe(3000);
    expect(value.DB_PASSWORD).toBe('daii_dev_only');
  });

  it('fails fast when a required value is missing', () => {
    const { error } = configurationValidationSchema.validate({ NODE_ENV: 'development' });
    expect(error).toBeDefined();
    expect(error!.details.some((d) => d.path.includes('DB_HOST'))).toBe(true);
  });

  it('refuses the dev-only default DB_PASSWORD when NODE_ENV=production', () => {
    const { error } = configurationValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 'daii_dev_only',
    });
    expect(error).toBeDefined();
  });

  it('accepts a real secret in production', () => {
    const { error } = configurationValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 'a-real-production-secret',
      JWT_ACCESS_SECRET: 'a-real-32-character-minimum-secret-value',
      JWT_REFRESH_SECRET: 'another-real-32-character-minimum-secret',
      INTEGRATION_ENCRYPTION_KEY: 'a-real-32-character-minimum-key-value',
    });
    expect(error).toBeUndefined();
  });

  it('refuses the dev-only default JWT secrets when NODE_ENV=production', () => {
    const { error } = configurationValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 'a-real-production-secret',
      JWT_ACCESS_SECRET: 'daii_dev_jwt_access_secret_do_not_use_in_prod',
      JWT_REFRESH_SECRET: 'a-real-32-character-minimum-secret-value',
      INTEGRATION_ENCRYPTION_KEY: 'a-real-32-character-minimum-key-value',
    });
    expect(error).toBeDefined();
  });

  it('refuses the dev-only default INTEGRATION_ENCRYPTION_KEY when NODE_ENV=production', () => {
    const { error } = configurationValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 'a-real-production-secret',
      JWT_ACCESS_SECRET: 'a-real-32-character-minimum-secret-value',
      JWT_REFRESH_SECRET: 'another-real-32-character-minimum-secret',
      INTEGRATION_ENCRYPTION_KEY: 'daii_dev_integration_encryption_key_do_not_use_in_prod',
    });
    expect(error).toBeDefined();
  });
});
